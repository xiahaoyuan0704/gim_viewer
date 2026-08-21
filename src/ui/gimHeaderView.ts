import type { GimHeaderInfo } from '../gim/types.js';
import { escHtml } from '../shared/html.js';

const panel = document.getElementById('gim-header-panel') as HTMLElement;

/** Render GIMPKGS metadata as an inspectable table before or after extraction. */
export function renderGimHeader(info: GimHeaderInfo): void {
  const rows = info.fields.map(({ key, value }) =>
    `<tr><td class="prop-key">${escHtml(key)}</td><td class="prop-val">${escHtml(value)}</td></tr>`,
  ).join('');
  panel.innerHTML = `<div class="header-card"><div class="header-card-title">GIM 文件头</div><table class="props-table">${rows}</table></div>`;
}

export function clearGimHeader(): void {
  panel.innerHTML = '<div class="props-empty">打开 GIM 文件后显示文件头信息</div>';
}
