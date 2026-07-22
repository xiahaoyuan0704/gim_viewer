import * as OBC from '@thatopen/components';
import * as THREE from 'three';
import type { ViewerContext } from './viewerEngine.js';
import type { AppState } from '../app/state.js';
import type { CbmNode } from '../gim/types.js';
import { resetHighlight, HIGHLIGHT_STYLE } from './highlight.js';

export type OnElementSelected = (modelId: string, localId: number) => void;
export type OnNativeNodeSelected = (node: CbmNode) => void;

function selectNativeNode(
  ctx: ViewerContext,
  state: AppState,
  container: HTMLElement,
  event: MouseEvent,
  onNativeNodeSelected: OnNativeNodeSelected,
): boolean {
  const canvas = container.querySelector('canvas') as HTMLCanvasElement | null;
  const rect = (canvas || container).getBoundingClientRect();
  const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  const root = ((ctx.world.scene as any).three as THREE.Scene).getObjectByName('GIM_NATIVE_ROOT');
  if (!root) return false;
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, (ctx.world.camera as any).three);
  for (const hit of raycaster.intersectObject(root, true)) {
    let owner: THREE.Object3D | null = hit.object;
    while (owner && !owner.userData.cbmPath) owner = owner.parent;
    if (!owner) continue;
    const fileName = String(owner.userData.cbmPath).split('/').pop() || '';
    const node = state.cbmNodeIndex.get(fileName);
    if (!node) continue;
    onNativeNodeSelected(node);
    window.dispatchEvent(new CustomEvent('gim-selection', { detail: { node } }));
    return true;
  }
  return false;
}

/** 注册 3D canvas 点击拾取 */
export function setupSelection(
  ctx: ViewerContext,
  state: AppState,
  container: HTMLElement,
  onElementSelected: OnElementSelected,
  onNativeNodeSelected: OnNativeNodeSelected,
): void {
  container.addEventListener('click', async (e: MouseEvent) => {
    if (!state.initialized) return;
    const canvas = container.querySelector('canvas');
    if (e.target !== container && e.target !== canvas) return;

    const mouse = new THREE.Vector2(e.clientX, e.clientY);

    try {
      if (selectNativeNode(ctx, state, container, e, onNativeNodeSelected)) return;
      const result = await ctx.fragments.raycast({
        camera: (ctx.world.camera as any).three,
        mouse,
        dom: (container.querySelector('canvas') as HTMLCanvasElement) || container,
      });

      if (!result) {
        await resetHighlight(ctx, state);
        return;
      }

      const { localId, fragments: hitModel } = result;
      const modelId = hitModel.modelId;

      // 高亮选中构件
      await resetHighlight(ctx, state);
      const items: OBC.ModelIdMap = { [modelId]: new Set([localId]) };
      await ctx.fragments.highlight(HIGHLIGHT_STYLE, items as any);
      state.highlightedItems = items as any;

      // 通知外部
      onElementSelected(modelId, localId);
      window.dispatchEvent(new CustomEvent('gim-selection', { detail: { modelId } }));
    } catch (err) {
      console.warn('射线拾取失败:', err);
    }
  });
}
