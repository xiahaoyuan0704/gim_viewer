import type { AppState } from '../app/state.js';
import { getEquipmentInventory } from '../services/equipmentInventoryService.js';

const button = document.getElementById('btn-equipment-inventory') as HTMLButtonElement;

function xml(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function createExcelWorkbook(rows: Awaited<ReturnType<typeof getEquipmentInventory>>): string {
  const rowXml = rows.map((row) => `
    <Row ss:StyleID="Cell">
      <Cell><Data ss:Type="String">${xml(row.name)}</Data></Cell>
      <Cell><Data ss:Type="Number">${row.subdeviceQuantity}</Data></Cell>
      <Cell><Data ss:Type="Number">${row.quantity}</Data></Cell>
    </Row>`).join('');
  const usedSheetNames = new Set<string>(['设备统计清单']);
  const detailSheets = rows
    .filter((row) => row.quantity > 0 && row.parameterDetails.length > 0)
    .map((row) => {
      const detailRows = row.parameterDetails.map((parameter) => `
    <Row ss:StyleID="Cell">
      <Cell><Data ss:Type="String">${xml(parameter.name)}</Data></Cell>
      <Cell><Data ss:Type="String">${xml(parameter.values.join('；'))}</Data></Cell>
    </Row>`).join('');
      return `
 <Worksheet ss:Name="${xml(createWorksheetName(row.name, row.category, usedSheetNames))}">
  <Table ss:DefaultRowHeight="20">
   <Column ss:Width="180"/><Column ss:Width="420"/>
   <Row ss:StyleID="Header"><Cell><Data ss:Type="String">关键参数</Data></Cell><Cell><Data ss:Type="String">具体信息</Data></Cell></Row>
   ${detailRows}
  </Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane><ActivePane>2</ActivePane></WorksheetOptions>
 </Worksheet>`;
    }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Header"><Font ss:Bold="1"/><Interior ss:Color="#D9EAF7" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/></Borders></Style>
  <Style ss:ID="Cell"><Alignment ss:Vertical="Center" ss:WrapText="1"/></Style>
 </Styles>
 <Worksheet ss:Name="设备统计清单">
  <Table ss:DefaultRowHeight="20">
   <Column ss:Width="180"/><Column ss:Width="110"/><Column ss:Width="90"/>
   <Row ss:StyleID="Header"><Cell><Data ss:Type="String">设备名称</Data></Cell><Cell><Data ss:Type="String">子设备数量</Data></Cell><Cell><Data ss:Type="String">设备数量</Data></Cell></Row>
   ${rowXml}
  </Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane><ActivePane>2</ActivePane></WorksheetOptions>
 </Worksheet>
 ${detailSheets}
</Workbook>`;
}

/** SpreadsheetML 工作表名称最长 31 个字符，且不能包含 Excel 保留字符。 */
function createWorksheetName(name: string, category: string, usedNames: Set<string>): string {
  const sanitize = (value: string) => value.replace(/[\\/?*\[\]:]/g, '／');
  const base = sanitize(name).slice(0, 31) || '设备参数';
  let candidate = base;
  let suffixIndex = 1;
  while (usedNames.has(candidate)) {
    const suffix = `（${sanitize(category || String(suffixIndex))}）`;
    candidate = `${base.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`.slice(0, 31);
    if (usedNames.has(candidate)) {
      const numericSuffix = `_${suffixIndex++}`;
      candidate = `${base.slice(0, 31 - numericSuffix.length)}${numericSuffix}`;
    }
  }
  usedNames.add(candidate);
  return candidate;
}

function downloadExcel(content: string): void {
  const blob = new Blob(['\ufeff', content], { type: 'application/vnd.ms-excel;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `GIM设备统计清单_${new Date().toISOString().slice(0, 10)}.xls`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function setupEquipmentInventoryExport(state: AppState): void {
  button.addEventListener('click', async () => {
    if (!state.currentFiles) {
      const text = button.textContent || '导出设备清单';
      button.textContent = '请先打开 GIM 文件';
      setTimeout(() => { button.textContent = text; }, 1800);
      return;
    }
    const originalText = button.textContent || '导出设备清单';
    button.disabled = true;
    button.textContent = '正在整理并导出...';
    let failed = false;
    try {
      const rows = await getEquipmentInventory(state);
      downloadExcel(createExcelWorkbook(rows));
    } catch (error) {
      failed = true;
      console.error('设备统计清单导出失败:', error);
    } finally {
      button.textContent = failed ? '导出失败，请重试' : '导出完成';
      setTimeout(() => { button.disabled = false; button.textContent = originalText; }, 1200);
    }
  });
}
