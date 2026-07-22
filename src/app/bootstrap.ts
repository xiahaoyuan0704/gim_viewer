import { AppState } from './state.js';
import { createViewerEngine } from '../viewer/viewerEngine.js';
import { ensureEngineReady } from '../viewer/ifcLoader.js';
import { setupSelection } from '../viewer/selection.js';
import { setupTabs } from '../ui/tabs.js';
import { setupPropsDrawer, showIfcElementProperties, showNodeProperties, openPropsDrawer } from '../ui/propsDrawer.js';
import { addModelToUI, removeModelFromUI } from '../ui/modelList.js';
import { setupIfcSelectModal } from '../ui/ifcSelectModal.js';
import { setupProjectScaleModal } from '../ui/projectScaleModal.js';
import { setupViewportActions } from '../ui/viewportActions.js';
import { setupOpenGimService, loadSelectedIfcFiles } from '../services/openGimService.js';
import { setupOpenIfcService } from '../services/openIfcService.js';
import { resetHighlight } from '../viewer/highlight.js';
import { clearMeshModels } from '../viewer/meshLoader.js';
import { removePreviousNativeRoot } from '../gim/nativeGimRenderer.js';
import { clearGimHeader } from '../ui/gimHeaderView.js';
import { container, btnClear, loadingEl } from '../ui/dom.js';
import type { ModelEventCallbacks } from '../viewer/ifcLoader.js';

function showLoading(text: string) { loadingEl.textContent = text; loadingEl.style.display = 'block'; }
function hideLoading() { loadingEl.style.display = 'none'; }

/** 异步启动逻辑 */
async function bootstrapAsync(): Promise<void> {
  // 创建状态
  const state = new AppState();

  // 初始化 3D 引擎（同步部分，不依赖 worker/wasm）
  const ctx = createViewerEngine(container);

  // 模型事件回调（供 ensureEngineReady 使用）
  const modelCallbacks: ModelEventCallbacks = {
    onModelAdded: (modelId) => addModelToUI(ctx, state, modelId),
    onModelRemoved: (modelId) => removeModelFromUI(modelId),
  };

  // 1. 先绑定所有 UI 事件（不依赖 fragments.init）
  setupTabs();
  setupPropsDrawer(ctx);
  setupIfcSelectModal({
    onLoadSelected: () => loadSelectedIfcFiles(ctx, state, modelCallbacks),
  });
  setupProjectScaleModal(state);
  setupViewportActions(ctx, state);
  setupSelection(ctx, state, container, (modelId, localId) => {
    showIfcElementProperties(ctx, state, modelId, localId);
  }, (node) => {
    void showNodeProperties(ctx, state, node);
    openPropsDrawer(ctx);
  });
  setupOpenGimService(ctx, state, (text) => showLoading(text));
  setupOpenIfcService(ctx, state, modelCallbacks);

  // 清空场景
  btnClear.addEventListener('click', async () => {
    for (const [modelId] of state.loadedModels) {
      ctx.fragments.core.disposeModel(modelId);
    }
    removePreviousNativeRoot(ctx);
    clearMeshModels(state);
    state.reset();
    document.getElementById('model-list')!.innerHTML = '';
    document.getElementById('cbm-tree-panel')!.innerHTML = '';
    document.getElementById('file-dev-panel')!.innerHTML = '';
    clearGimHeader();
    document.getElementById('props-drawer-body')!.innerHTML = '<div class="props-empty">选择层级树节点查看属性</div>';
    document.getElementById('empty-tip')!.style.display = '';
    await resetHighlight(ctx, state);
  });

  // 2. 异步初始化 FragmentsManager + 注册模型事件
  //    放在 UI 绑定之后，避免 WASM/Worker 加载阻塞 UI 交互
  try {
    await ensureEngineReady(ctx, state, modelCallbacks);
  } catch (err) {
    console.error('引擎初始化失败，将在首次加载 IFC 时重试:', err);
  }

  hideLoading();
}

/** 应用启动入口（同步包装） */
export function bootstrap(): void {
  bootstrapAsync();
}
