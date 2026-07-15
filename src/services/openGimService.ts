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
import { alignNativeRootToLoadedIfc, renderNativeGimModel } from '../gim/nativeGimRenderer.js';

function showLoading(text: string) { loadingEl.textContent = text; loadingEl.style.display = 'block'; }
function hideLoading() { loadingEl.style.display = 'none'; }


function waitForViewerFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}


function getNativeOverlayCbmFiles(state: AppState, selected: IfcEntry[]): Set<string> | undefined {
  const selectedModelIds = new Set(selected.map((entry) => entry.modelId));
  const cbmFiles = new Set<string>();
  for (const relation of state.fileDevRelations) {
    if (!selectedModelIds.has(relation.modelId)) continue;
    for (const cbm of relation.deviceCbms) cbmFiles.add(cbm);
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
        const overlayCbmFiles = getNativeOverlayCbmFiles(state, selected);
        const nativeResult = await renderNativeGimModel(ctx, state, state.currentFiles, { cbmFiles: overlayCbmFiles });
        if (nativeResult) {
          ctx.fragments.core.update(true);
          await waitForViewerFrame();
          if (await alignNativeRootToLoadedIfc(ctx, state, nativeResult.group, overlayCbmFiles)) state.hasFittedCamera = false;
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
      const { extractGimFile } = await import('../gim/gimExtractor.js');
      const extracted = await extractGimFile(toArrayBuffer(selectedFile.data));
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
      const { extractGimFile } = await import('../gim/gimExtractor.js');
      showLoading('正在解压 GIM 文件...');
      const ab = await files[0].arrayBuffer();
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
