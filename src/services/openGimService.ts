import type { IfcEntry } from '../gim/types.js';
import type { AppState } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import type { ModelEventCallbacks } from '../viewer/ifcLoader.js';
import { scanIfcFiles, discoverIfcFromCBM, buildIfcGuidIndex } from '../gim/gimIndexer.js';
import { buildCbmTree, buildCbmNodeIndex } from '../gim/cbmParser.js';
import { parseFileDevRelation } from '../gim/fileDevParser.js';
import { ensureEngineReady, loadIfcBuffer } from '../viewer/ifcLoader.js';
import { buildIfcNameIndex } from '../viewer/ifcNameIndex.js';
import { fitCameraToScene } from '../viewer/camera.js';
import { openIfcModal, getModalSelectedEntries, closeIfcModal } from '../ui/ifcSelectModal.js';
import { buildAndRenderCbmTree } from '../ui/cbmTreeView.js';
import { renderFileDevPanel } from '../ui/fileDevView.js';
import { loadingEl, emptyTipEl, gimFileInput, btnLoadGim } from '../ui/dom.js';
import { isDesktopRuntime, toArrayBuffer } from '../desktop/electron.js';
import { renderNativeGimModel } from '../gim/nativeGimRenderer.js';
import { extractGimFile, parseGimHeader } from '../gim/gimExtractor.js';
import { renderGimHeader } from '../ui/gimHeaderView.js';

function showLoading(text: string) { loadingEl.textContent = text; loadingEl.style.display = 'block'; }
function hideLoading() { loadingEl.style.display = 'none'; }


function waitForViewerFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}


function normalizeModelRef(value: string): string {
  return value.replace(/\\/g, '/').split('/').pop()!.replace(/\.ifc$/i, '').trim().toLocaleLowerCase('zh-CN');
}

function getNativeOverlayCbmFiles(state: AppState, selected: IfcEntry[]): Set<string> | undefined {
  const selectedModelIds = new Set(selected.flatMap((entry) => [normalizeModelRef(entry.modelId), normalizeModelRef(entry.name), normalizeModelRef(entry.path)]));
  const cbmFiles = new Set<string>();
  for (const relation of state.fileDevRelations) {
    const relationRefs = [relation.modelId, relation.ifcName, relation.ifcFile].map(normalizeModelRef);
    if (!relationRefs.some((ref) => selectedModelIds.has(ref))) continue;
    for (const cbm of relation.deviceCbms) cbmFiles.add(cbm);
  }
  if (cbmFiles.size > 0) return cbmFiles;
  // 少数 GIM 没有 FileDevRelation，或其 IFC 名称与包内文件不一致；回退到所有带 DEV 指针的设备节点，确保电气设备仍能叠加。
  for (const node of state.cbmNodeIndex.values()) {
    if (node.devPath) cbmFiles.add(node.path.split('/').pop() || node.path);
  }
  return cbmFiles.size > 0 ? cbmFiles : undefined;
}

/** GIM 文件解压后的处理流程 */
export async function onGimExtracted(ctx: ViewerContext, state: AppState, files: Map<string, File>, showMessage: (text: string) => void): Promise<IfcEntry[]> {
  state.currentFiles = files;

  // 发现 IFC 文件
  let ifcEntries = await discoverIfcFromCBM(files);
  if (ifcEntries.length === 0) ifcEntries = scanIfcFiles(files);

  state.currentIfcEntries = ifcEntries;

  // 构建 CBM 层级树
  state.currentCbmTree = await buildCbmTree(files);
  state.ifcGuidIndex = buildIfcGuidIndex(state.currentCbmTree);
  state.cbmNodeIndex = buildCbmNodeIndex(state.currentCbmTree);

  // 解析 FileDevRelation
  state.fileDevRelations = await parseFileDevRelation(files);
  state.deviceToIfcFile.clear();
  for (const entry of state.fileDevRelations) {
    for (const devCbm of entry.deviceCbms) {
      state.deviceToIfcFile.set(devCbm, entry.modelId);
    }
  }

  // 渲染层级树和文件设备面板
  buildAndRenderCbmTree(ctx, state, showMessage);
  renderFileDevPanel(ctx, state, showMessage);

  return ifcEntries;
}

/** 加载选中的 IFC 文件 */
export async function loadSelectedIfcFiles(ctx: ViewerContext, state: AppState, modelCallbacks: ModelEventCallbacks): Promise<void> {
  const selected = getModalSelectedEntries(state.currentIfcEntries);
  if (selected.length === 0) return;
  closeIfcModal();
  showLoading('正在加载 IFC 模型...');
  try {
    await ensureEngineReady(ctx, state, modelCallbacks);
    for (const entry of selected) {
      if (!state.currentFiles) break;
      const file = state.currentFiles.get(entry.path);
      if (!file) continue;
      const buffer = new Uint8Array(await file.arrayBuffer());
      showLoading(`正在加载 ${entry.name}...`);
      await loadIfcBuffer(ctx, entry.name, buffer, state, (p) => showLoading(`${entry.name}: ${Math.round(p * 100)}%`));
    }
    await buildIfcNameIndex(ctx, state);
    if (state.currentFiles) {
      try {
        showLoading('正在叠加 GIM 原生设备细节...');
        ctx.fragments.core.update(true);
        await waitForViewerFrame();
        // 只叠加当前 IFC 所关联的电气设备，避免把整个 GIM 的 DEV/PHM/MOD 一次性送入 GPU 而掉帧或白屏。
        const overlayCbmFiles = getNativeOverlayCbmFiles(state, selected);
        let nativeResult = overlayCbmFiles
          ? await renderNativeGimModel(ctx, state, state.currentFiles, { cbmFiles: overlayCbmFiles, alignToIfc: false, coordinateWithIfc: true })
          : null;
        // 线路工程、旧版变电站包可能没有 FileDevRelation，或者其 CBM
        // 引用方式与当前选中的 IFC 名称不一致。精确叠加没有产出时必须
        // 回退到包内完整 CBM/DEV 根，而不能静默结束后只留下 IFC。
        if (!nativeResult) {
          console.warn('未通过 IFC-CBM 关系找到设备，回退到完整 GIM 原生设备。');
          nativeResult = await renderNativeGimModel(ctx, state, state.currentFiles, {
            alignToIfc: false,
            coordinateWithIfc: true,
          });
        }
        if (nativeResult) {
          ctx.fragments.core.update(true);
          await waitForViewerFrame();
        } else {
          console.warn('GIM 包内未找到可渲染的 CBM/DEV/PHM/MOD 设备几何。');
        }
      } catch (nativeErr) {
        console.warn('GIM 原生细节渲染失败，继续显示 IFC:', nativeErr);
      }
    }
    buildAndRenderCbmTree(ctx, state, (text) => showLoading(text));
    renderFileDevPanel(ctx, state, (text) => showLoading(text));
    emptyTipEl.style.display = 'none';
    fitCameraToScene(ctx, state);
  } catch (err) {
    console.error(err);
    showLoading(`IFC 加载失败: ${err instanceof Error ? err.message : String(err)}`);
    setTimeout(hideLoading, 3000);
    return;
  }
  hideLoading();
}

/** 绑定 GIM 文件打开事件 */
export function setupOpenGimService(ctx: ViewerContext, state: AppState, showMessage: (text: string) => void): void {
  async function openGimFromDesktopDialog(): Promise<void> {
    btnLoadGim.disabled = true;
    try {
      const selectedFile = await window.gimDesktop?.openGimFile();
      if (!selectedFile) return;
      showLoading(`正在解压 GIM 文件: ${selectedFile.name}...`);
      const source = toArrayBuffer(selectedFile.data);
      renderGimHeader(parseGimHeader(source, selectedFile.name));
      const extracted = await extractGimFile(source);
      const entries = await onGimExtracted(ctx, state, extracted, showMessage);
      if (entries.length === 0) {
        const nativeResult = await renderNativeGimModel(ctx, state, extracted);
        if (nativeResult) {
          emptyTipEl.style.display = 'none';
          showLoading(`已加载 GIM 原生几何: ${nativeResult.meshCount} 个图元`);
          setTimeout(hideLoading, 1800);
          return;
        }
        showLoading('未在 GIM 文件中找到可渲染的 IFC/MOD/PHM/DEV 内容'); setTimeout(hideLoading, 3000); return;
      }
      hideLoading();
      openIfcModal(entries);
    } catch (err) {
      console.error(err);
      showLoading(`GIM 解析失败: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(hideLoading, 3000);
    } finally { btnLoadGim.disabled = false; }
  }

  btnLoadGim.addEventListener('click', async () => {
    if (!isDesktopRuntime()) {
      gimFileInput.click();
      return;
    }
    await openGimFromDesktopDialog();
  });
  window.gimDesktop?.onOpenGimFileRequested(() => { void openGimFromDesktopDialog(); });
  gimFileInput.addEventListener('change', async () => {
    const files = Array.from(gimFileInput.files || []);
    if (files.length === 0) return;
    btnLoadGim.disabled = true;
    try {
      showLoading('正在加载 GIM 解压模块...');
      showLoading('正在解压 GIM 文件...');
      const ab = await files[0].arrayBuffer();
      renderGimHeader(parseGimHeader(ab, files[0].name));
      const extracted = await extractGimFile(ab);
      const entries = await onGimExtracted(ctx, state, extracted, showMessage);
      if (entries.length === 0) {
        const nativeResult = await renderNativeGimModel(ctx, state, extracted);
        if (nativeResult) {
          emptyTipEl.style.display = 'none';
          showLoading(`已加载 GIM 原生几何: ${nativeResult.meshCount} 个图元`);
          setTimeout(hideLoading, 1800);
          return;
        }
        showLoading('未在 GIM 文件中找到可渲染的 IFC/MOD/PHM/DEV 内容'); setTimeout(hideLoading, 3000); return;
      }
      hideLoading();
      openIfcModal(entries);
    } catch (err) {
      console.error(err);
      showLoading(`GIM 解析失败: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(hideLoading, 3000);
    } finally { gimFileInput.value = ''; btnLoadGim.disabled = false; }
  });
}
