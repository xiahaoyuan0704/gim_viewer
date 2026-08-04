import type { AppState } from '../app/state.js';
import { EQUIPMENT_CATEGORY_COUNT, getEquipmentInventory } from '../services/equipmentInventoryService.js';
import { escHtml } from '../shared/html.js';

const modal = document.getElementById('equipment-inventory-modal') as HTMLElement;
const body = document.getElementById('equipment-inventory-body') as HTMLElement;
const close = document.getElementById('equipment-inventory-close') as HTMLButtonElement;
const button = document.getElementById('btn-equipment-inventory') as HTMLButtonElement;

export function setupEquipmentInventoryModal(state: AppState): void {
  button.addEventListener('click', async () => {
    modal.classList.add('open');
    if (!state.currentFiles) {
      body.innerHTML = '<div class="props-empty">请先打开 GIM 文件</div>';
      return;
    }
    body.innerHTML = '<div class="props-empty">正在整理设备名称、关键参数和数量...</div>';
    try {
      const rows = await getEquipmentInventory(state);
      const total = rows.reduce((sum, row) => sum + row.quantity, 0);
      body.innerHTML = `
        <div class="equipment-inventory-summary">共 ${EQUIPMENT_CATEGORY_COUNT} 类设备，识别到 ${total} 台（套）设备</div>
        <table class="equipment-inventory-table">
          <thead><tr><th>设备名称</th><th>关键参数信息</th><th>数量</th></tr></thead>
          <tbody>${rows.map((row) => `<tr><td>${escHtml(row.name)}</td><td>${row.keyParameters.map(escHtml).join('、')}</td><td>${row.quantity}</td></tr>`).join('')}</tbody>
        </table>`;
    } catch (error) {
      body.innerHTML = `<div class="props-empty">设备清单整理失败：${escHtml(error instanceof Error ? error.message : String(error))}</div>`;
    }
  });
  close.addEventListener('click', () => modal.classList.remove('open'));
  modal.addEventListener('click', (event) => { if (event.target === modal) modal.classList.remove('open'); });
}
