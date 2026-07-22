import type { AppState } from '../app/state.js';
import { getSubstationScale } from '../services/projectScaleService.js';
import { escHtml } from '../shared/html.js';

const modal = document.getElementById('project-scale-modal') as HTMLElement;
const body = document.getElementById('project-scale-body') as HTMLElement;
const close = document.getElementById('project-scale-close') as HTMLButtonElement;
const button = document.getElementById('btn-project-scale') as HTMLButtonElement;

export function setupProjectScaleModal(state: AppState): void {
  button.addEventListener('click', async () => {
    modal.classList.add('open');
    if (!state.currentFiles) { body.innerHTML = '<div class="props-empty">请先打开 GIM 文件</div>'; return; }
    body.innerHTML = '<div class="props-empty">正在读取工程属性信息...</div>';
    try {
      const rows = await getSubstationScale(state);
      body.innerHTML = `<table class="project-scale-table"><thead><tr><th>属性字段</th><th>属性值</th></tr></thead><tbody>${rows.map(({ label, value }) => `<tr><td>${escHtml(label)}</td><td>${escHtml(value)}</td></tr>`).join('')}</tbody></table>`;
    } catch (error) { body.innerHTML = `<div class="props-empty">工程属性读取失败：${escHtml(error instanceof Error ? error.message : String(error))}</div>`; }
  });
  close.addEventListener('click', () => modal.classList.remove('open'));
  modal.addEventListener('click', (event) => { if (event.target === modal) modal.classList.remove('open'); });
}
