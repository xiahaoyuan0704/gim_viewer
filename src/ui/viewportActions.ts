import * as THREE from 'three';
import type { AppState } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import type { CbmNode } from '../gim/types.js';
import { container } from './dom.js';

type Target = { modelId: string } | { node: CbmNode } | null;

/** Bind grid toggle and context actions for the last selected IFC/native device. */
export function setupViewportActions(ctx: ViewerContext, state: AppState): void {
  const gridButton = document.getElementById('btn-toggle-grid') as HTMLButtonElement;
  gridButton.addEventListener('click', () => {
    ctx.grid.visible = !ctx.grid.visible;
    gridButton.textContent = ctx.grid.visible ? '隐藏网格线' : '显示网格线';
  });

  const menu = document.getElementById('selection-menu') as HTMLElement;
  let target: Target = null;
  window.addEventListener('gim-selection', (event) => { target = (event as CustomEvent<Target>).detail; });
  container.addEventListener('contextmenu', (event) => {
    if (!target) return;
    event.preventDefault();
    menu.style.left = `${event.clientX}px`; menu.style.top = `${event.clientY}px`;
    menu.classList.add('open');
  });
  document.addEventListener('click', () => menu.classList.remove('open'));
  menu.addEventListener('click', (event) => {
    const action = (event.target as HTMLElement).dataset.action;
    if (!action) return;
    event.stopPropagation();
    applyAction(ctx, state, target, action);
    menu.classList.remove('open');
  });
}

function nativeGroup(ctx: ViewerContext, node: CbmNode): THREE.Object3D | null {
  const root = ((ctx.world.scene as any).three as THREE.Scene).getObjectByName('GIM_NATIVE_ROOT');
  let result: THREE.Object3D | null = null;
  root?.traverse((object: THREE.Object3D) => { if (object.userData.cbmPath === node.path) result = object; });
  return result;
}

function applyAction(ctx: ViewerContext, state: AppState, target: Target, action: string): void {
  const models = Array.from(state.loadedModels.keys()).map((id) => ctx.fragments.list.get(id)).filter(Boolean);
  const nativeRoot = ((ctx.world.scene as any).three as THREE.Scene).getObjectByName('GIM_NATIVE_ROOT');
  if (action === 'show-all') {
    for (const model of models) model!.object.visible = true;
    nativeRoot?.traverse((object: THREE.Object3D) => { object.visible = true; });
    return;
  }
  if (!target) return;
  if ('modelId' in target) {
    for (const model of models) model!.object.visible = action === 'isolate' ? model!.modelId === target.modelId : model!.modelId !== target.modelId;
    return;
  }
  const chosen = nativeGroup(ctx, target.node);
  if (!chosen) return;
  if (action === 'hide') { chosen.visible = false; return; }
  // 隔离原生设备时，隐藏所有 IFC 模型和其他 CBM 设备，仅保留当前设备及其部件层级。
  for (const model of models) model!.object.visible = false;
  nativeRoot?.traverse((object: THREE.Object3D) => {
    if (!object.userData.cbmPath) return;
    let withinChosen = object === chosen;
    for (let parent = object.parent; !withinChosen && parent; parent = parent.parent) withinChosen = parent === chosen;
    object.visible = withinChosen;
  });
}
