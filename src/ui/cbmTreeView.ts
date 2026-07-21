import * as THREE from 'three';
import type { CbmNode } from '../gim/types.js';
import type { AppState } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import { cbmTreePanel } from './dom.js';
import { getNodeDisplayName } from '../gim/gimIndexer.js';
import { showNodeProperties, openPropsDrawer } from './propsDrawer.js';
import { highlightIfcFromNode } from '../viewer/highlight.js';

function getHierarchyLabel(node: CbmNode, state: AppState): string {
  const display = getNodeDisplayName(node, state.ifcGuidToName);
  if (node.path.toLowerCase().endsWith('project.cbm')) return `工程：${display === 'project.cbm' ? '未命名工程' : display}`;
  const prefix = node.entityName || '部件';
  const suffix = display && display !== prefix ? `_${display}` : '';
  const count = node.children.length > 0 ? ` (${node.children.length})` : '';
  return `${prefix}${suffix}${count}`;
}

function findNativeNodeGroup(ctx: ViewerContext, node: CbmNode): THREE.Object3D | null {
  const root = ((ctx.world.scene as any).three as THREE.Scene).getObjectByName('GIM_NATIVE_ROOT');
  if (!root) return null;
  let found: THREE.Object3D | null = null;
  root.traverse((object) => { if (object.userData.cbmPath === node.path) found = object; });
  return found;
}

function setNativeNodeVisibility(ctx: ViewerContext, node: CbmNode, visible: boolean): boolean {
  const group = findNativeNodeGroup(ctx, node);
  if (!group) return false;
  group.visible = visible;
  return true;
}

const ENTITY_ICONS: Record<string, string> = {
  F1System: '🏗️', F2System: '🏢', F3System: '⚡', F4System: '🔧', PARTINDEX: '🔩',
};

/** 渲染 CBM 层级树 */
export function renderCbmTree(
  ctx: ViewerContext,
  state: AppState,
  node: CbmNode,
  parentEl: HTMLElement,
  showMessage: (text: string) => void,
): void {
  const nodeEl = document.createElement('div');
  nodeEl.className = 'tree-node';
  const row = document.createElement('div');
  row.className = 'tree-row';
  const toggle = document.createElement('span');
  toggle.className = `tree-toggle ${node.children.length === 0 ? 'leaf' : ''}`;
  toggle.textContent = '▶';
  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = ENTITY_ICONS[node.entityName] || '📁';
  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = getHierarchyLabel(node, state);
  label.title = node.path;
  const visibility = document.createElement('input');
  visibility.type = 'checkbox'; visibility.className = 'tree-model-checkbox'; visibility.title = '显示/隐藏此层级模型';
  const nativeGroup = findNativeNodeGroup(ctx, node);
  visibility.checked = nativeGroup?.visible ?? true; visibility.disabled = !nativeGroup;
  visibility.addEventListener('click', (event) => event.stopPropagation());
  visibility.addEventListener('change', () => { setNativeNodeVisibility(ctx, node, visibility.checked); });
  row.appendChild(toggle); row.appendChild(visibility); row.appendChild(icon); row.appendChild(label);
  nodeEl.appendChild(row);
  const childrenEl = document.createElement('div');
  childrenEl.className = 'tree-children';
  nodeEl.appendChild(childrenEl);

  let expanded = false;
  let childrenRendered = false;
  row.addEventListener('click', () => {
    document.querySelectorAll('.tree-row.selected').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
    showNodeProperties(ctx, state, node);
    openPropsDrawer(ctx);
    highlightIfcFromNode(ctx, state, node, showMessage);
    if (node.children.length > 0) {
      expanded = !expanded;
      toggle.classList.toggle('expanded', expanded);
      childrenEl.classList.toggle('expanded', expanded);
      if (expanded && !childrenRendered) {
        for (const child of node.children) renderCbmTree(ctx, state, child, childrenEl, showMessage);
        childrenRendered = true;
      }
    }
  });
  parentEl.appendChild(nodeEl);
}

/** 构建并渲染 CBM 层级树 */
export function buildAndRenderCbmTree(ctx: ViewerContext, state: AppState, showMessage: (text: string) => void): void {
  cbmTreePanel.innerHTML = '';
  if (!state.currentCbmTree) { cbmTreePanel.innerHTML = '<div class="props-empty">加载 GIM 文件后显示层级树</div>'; return; }
  renderCbmTree(ctx, state, state.currentCbmTree, cbmTreePanel, showMessage);
  if (state.currentIfcEntries.length > 0) {
    const group = document.createElement('div');
    group.className = 'tree-node ifc-model-group';
    const groupRow = document.createElement('div');
    groupRow.className = 'tree-row';
    groupRow.innerHTML = '<span class="tree-toggle expanded">▶</span><span class="tree-icon">◈</span><span class="tree-label">IFC 模型</span>';
    const children = document.createElement('div');
    children.className = 'tree-children expanded';
    for (const entry of state.currentIfcEntries) {
      const row = document.createElement('label');
      row.className = 'tree-row tree-model-row';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.checked = state.loadedModels.get(entry.modelId)?.visible ?? true;
      checkbox.className = 'tree-model-checkbox'; checkbox.title = '显示/隐藏模型';
      checkbox.addEventListener('change', () => {
        const model = ctx.fragments.list.get(entry.modelId);
        if (model) model.object.visible = checkbox.checked;
        const saved = state.loadedModels.get(entry.modelId);
        if (saved) saved.visible = checkbox.checked;
        const listCheckbox = document.querySelector(`#model-${CSS.escape(entry.modelId)} .model-checkbox`) as HTMLInputElement | null;
        if (listCheckbox) listCheckbox.checked = checkbox.checked;
      });
      const icon = document.createElement('span'); icon.className = 'tree-icon'; icon.textContent = '◫';
      const label = document.createElement('span'); label.className = 'tree-label'; label.textContent = `${entry.name}.ifc`; label.title = entry.path;
      row.append(checkbox, icon, label);
      children.appendChild(row);
    }
    groupRow.addEventListener('click', () => children.classList.toggle('expanded'));
    group.append(groupRow, children);
    cbmTreePanel.appendChild(group);
  }
}
