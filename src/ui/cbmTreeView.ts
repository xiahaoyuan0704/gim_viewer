import type { CbmNode } from '../gim/types.js';
import type { AppState } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import { cbmTreePanel } from './dom.js';
import { getNodeDisplayName } from '../gim/gimIndexer.js';
import { showNodeProperties, openPropsDrawer } from './propsDrawer.js';
import { highlightIfcFromNode } from '../viewer/highlight.js';

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
  label.textContent = getNodeDisplayName(node, state.ifcGuidToName);
  label.title = node.path;
  row.appendChild(toggle); row.appendChild(icon); row.appendChild(label);
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
