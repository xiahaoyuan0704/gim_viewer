import type { AppState } from '../app/state.js';
import type { CbmNode } from '../gim/types.js';
import { parseKeyValue } from '../gim/cbmParser.js';

export interface EquipmentInventoryRow {
  name: string;
  keyParameters: string[];
  quantity: number;
}

type CatalogItem = { name: string; aliases?: string[]; defaults: string[] };

const COMMON_PARAMETERS = ['设备型号', '额定电压', '额定电流', '生产厂家'];

/** 变电/换流工程设备统计目录（固定输出全部 51 类，未发现的设备数量为 0）。 */
const EQUIPMENT_CATALOG: CatalogItem[] = [
  { name: '油浸式变压器', defaults: ['设备型号', '额定容量', '额定电压', '冷却方式'] },
  { name: '干式变压器', defaults: ['设备型号', '额定容量', '额定电压', '绝缘等级'] },
  { name: '换流变压器', defaults: ['设备型号', '额定容量', '网侧电压', '阀侧电压'] },
  { name: '油浸式电抗器', defaults: ['设备型号', '额定电压', '额定容量', '电抗率'] },
  { name: '干式电抗器', defaults: ['设备型号', '额定电压', '额定电流', '电抗率'] },
  { name: '电磁式电流互感器', aliases: ['电磁式电流互感器', '电流互感器'], defaults: ['设备型号', '额定电压', '变比', '准确级'] },
  { name: '电子式电流互感器', defaults: ['设备型号', '额定电压', '变比', '准确级'] },
  { name: '电磁式电压互感器', aliases: ['电磁式电压互感器'], defaults: ['设备型号', '额定电压', '变比', '准确级'] },
  { name: '电容式电压互感器', defaults: ['设备型号', '额定电压', '变比', '准确级'] },
  { name: '电子式电压互感器', defaults: ['设备型号', '额定电压', '变比', '准确级'] },
  { name: '组合电器', aliases: ['组合电器'], defaults: ['设备型号', '额定电压', '额定电流', '开断电流'] },
  { name: '直流电压测量装置', defaults: ['设备型号', '额定直流电压', '测量范围', '准确级'] },
  { name: '组合电器GIS', aliases: ['GIS组合电器', '组合电器GIS', 'GIS'], defaults: ['设备型号', '额定电压', '额定电流', '气体压力'] },
  { name: '组合电器HGIS', aliases: ['HGIS组合电器', '组合电器HGIS', 'HGIS'], defaults: ['设备型号', '额定电压', '额定电流', '开断电流'] },
  { name: '交流滤波器', defaults: ['设备型号', '额定电压', '调谐频率', '额定容量'] },
  { name: '直流滤波器', defaults: ['设备型号', '额定直流电压', '调谐频率', '额定容量'] },
  { name: '交流避雷器', aliases: ['交流避雷器'], defaults: ['设备型号', '额定电压', '持续运行电压', '标称放电电流'] },
  { name: '直流旁路开关', defaults: ['设备型号', '额定直流电压', '额定电流', '开断电流'] },
  { name: '交流隔离开关', defaults: ['设备型号', '额定电压', '额定电流', '操作方式'] },
  { name: '交流接地开关', defaults: ['设备型号', '额定电压', '短时耐受电流', '操作方式'] },
  { name: '直流隔离开关', defaults: ['设备型号', '额定直流电压', '额定电流', '操作方式'] },
  { name: '直流接地开关', defaults: ['设备型号', '额定直流电压', '短时耐受电流', '操作方式'] },
  { name: '换流阀', defaults: ['设备型号', '额定直流电压', '额定电流', '冷却方式'] },
  { name: '消弧线圈/接地变压器成套装置', aliases: ['消弧线圈', '接地变压器成套装置'], defaults: ['设备型号', '额定容量', '额定电压', '补偿电流'] },
  { name: '接地电阻成套装置', defaults: ['设备型号', '额定电压', '电阻值', '额定时间'] },
  { name: '中性点成套设备', aliases: ['中性点成套装置', '中性点成套设备'], defaults: ['设备型号', '额定电压', '额定电流', '设备型式'] },
  { name: '隔直装置', defaults: ['设备型号', '额定电流', '隔直容量', '动作电压'] },
  { name: '框架式电容器组', defaults: ['设备型号', '额定电压', '额定容量', '接线方式'] },
  { name: '集合式电容器组', defaults: ['设备型号', '额定电压', '额定容量', '接线方式'] },
  { name: '串补电容器成套装置', aliases: ['串补电容器', '串联补偿装置'], defaults: ['设备型号', '额定电压', '额定容量', '补偿度'] },
  { name: '降压式SVG', aliases: ['降压式SVG'], defaults: ['设备型号', '额定电压', '额定容量', '冷却方式'] },
  { name: '直挂式SVG', aliases: ['直挂式SVG'], defaults: ['设备型号', '额定电压', '额定容量', '冷却方式'] },
  { name: 'SVC', aliases: ['静止无功补偿器', 'SVC'], defaults: ['设备型号', '额定电压', '额定容量', '调节范围'] },
  { name: '滤波器电容器', defaults: ['设备型号', '额定电压', '额定容量', '电容值'] },
  { name: '直流耦合电容器', defaults: ['设备型号', '额定直流电压', '额定容量', '电容值'] },
  { name: '电阻器', defaults: ['设备型号', '额定电压', '电阻值', '额定功率'] },
  { name: '高压开关柜', defaults: ['设备型号', '额定电压', '额定电流', '开断电流'] },
  { name: '低压开关柜', defaults: ['设备型号', '额定电压', '额定电流', '防护等级'] },
  { name: '熔断器', defaults: ['设备型号', '额定电压', '额定电流', '开断能力'] },
  { name: '避雷器', aliases: ['避雷器'], defaults: ['设备型号', '额定电压', '持续运行电压', '标称放电电流'] },
  { name: '直流避雷器/滤波器', aliases: ['直流避雷器', '直流避雷器/滤波器'], defaults: ['设备型号', '额定直流电压', '残压', '标称放电电流'] },
  { name: '交流支柱绝缘子', aliases: ['交流支柱绝缘子', '支柱绝缘子'], defaults: ['设备型号', '额定电压', '绝缘水平', '爬电距离'] },
  { name: '直流支柱绝缘子', defaults: ['设备型号', '额定直流电压', '绝缘水平', '爬电距离'] },
  { name: '交流穿墙套管', aliases: ['交流穿墙套管', '穿墙套管'], defaults: ['设备型号', '额定电压', '额定电流', '爬电距离'] },
  { name: '直流穿墙套管', defaults: ['设备型号', '额定直流电压', '额定电流', '爬电距离'] },
  { name: '平波电抗器', defaults: ['设备型号', '额定直流电流', '电感值', '绝缘水平'] },
  { name: '线路故障测量装置', defaults: ['设备型号', '额定电压', '测量范围', '测量精度'] },
  { name: '蓄电池组', defaults: ['设备型号', '标称电压', '额定容量', '蓄电池数量'] },
  { name: '预制舱体', defaults: ['设备型号', '舱体尺寸', '防护等级', '耐火等级'] },
  { name: '安防设备', defaults: ['设备型号', '设备类型', '安装位置', '生产厂家'] },
  { name: '火灾报警设备', defaults: ['设备型号', '设备类型', '保护范围', '生产厂家'] },
];

const inventoryCache = new WeakMap<Map<string, File>, Promise<EquipmentInventoryRow[]>>();

function normalize(value: string): string {
  return value.toUpperCase().replace(/[\s_\-—（）()\/]/g, '');
}

function resolveFile(files: Map<string, File>, ref: string, dirs: string[]): File | null {
  const clean = ref.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\$+$/, '').trim();
  const name = clean.split('/').pop()?.toLowerCase();
  const candidates = [clean, ...dirs.map((dir) => `${dir}/${clean.replace(/^\/?(?:CBM|DEV|FAM)\//i, '')}`)].map((path) => path.toLowerCase());
  for (const [path, file] of files) if (candidates.includes(path.toLowerCase()) || (name && path.split('/').pop()?.toLowerCase() === name)) return file;
  return null;
}

function decodeFamValue(key: string, value: string): { label: string; value: string } {
  const index = value.indexOf('=');
  return index > 0
    ? { label: value.slice(0, index).trim(), value: value.slice(index + 1).trim() }
    : { label: key, value: value.trim() };
}

function findCategory(candidates: string[]): number | null {
  const haystack = normalize(candidates.join('|'));
  let best: { index: number; length: number } | null = null;
  for (let index = 0; index < EQUIPMENT_CATALOG.length; index++) {
    const item = EQUIPMENT_CATALOG[index];
    for (const alias of item.aliases || [item.name]) {
      const token = normalize(alias);
      if (token && haystack.includes(token) && (!best || token.length > best.length)) best = { index, length: token.length };
    }
  }
  return best ? best.index : null;
}

function collectNodes(root: CbmNode | null): CbmNode[] {
  const result: CbmNode[] = [];
  const walk = (node: CbmNode) => { if (node.devPath) result.push(node); for (const child of node.children) walk(child); };
  if (root) walk(root);
  return result;
}

async function buildInventory(state: AppState): Promise<EquipmentInventoryRow[]> {
  const files = state.currentFiles;
  if (!files) return EQUIPMENT_CATALOG.map(({ name, defaults }) => ({ name, keyParameters: defaults, quantity: 0 }));
  const quantities = EQUIPMENT_CATALOG.map(() => 0);
  const availableParameters = EQUIPMENT_CATALOG.map(() => new Map<string, number>());
  const textCache = new WeakMap<File, Promise<Record<string, string>>>();
  const read = (file: File): Promise<Record<string, string>> => {
    let result = textCache.get(file);
    if (!result) { result = file.text().then(parseKeyValue); textCache.set(file, result); }
    return result;
  };

  const processNode = async (node: CbmNode): Promise<void> => {
    const candidates = [node.name, node.classifyName, node.entityName];
    const properties: Array<[string, string]> = [];
    const visitedFamilies = new Set<File>();
    const addProperties = async (file: File | null, dirs: string[]) => {
      if (!file || visitedFamilies.has(file)) return;
      visitedFamilies.add(file);
      const kv = await read(file);
      for (const [key, raw] of Object.entries(kv)) {
        if (/\.(?:fam|cbm|dev|phm|mod)$/i.test(raw.replace(/\$+$/, ''))) continue;
        const decoded = decodeFamValue(key, raw);
        properties.push([decoded.label, decoded.value]);
        candidates.push(decoded.label, decoded.value, raw);
      }
      if (kv.BASEFAMILY) await addProperties(resolveFile(files, kv.BASEFAMILY, dirs), dirs);
    };
    await addProperties(resolveFile(files, node.path, ['CBM']), ['CBM', 'FAM']);
    await addProperties(resolveFile(files, node.famPath, ['CBM', 'FAM']), ['CBM', 'FAM']);
    const devFile = resolveFile(files, node.devPath, ['DEV']);
    if (devFile) {
      const dev = await read(devFile);
      candidates.push(dev.SYMBOLNAME || '', dev.TYPE || '');
      await addProperties(resolveFile(files, dev.BASEFAMILY || '', ['DEV', 'FAM']), ['DEV', 'FAM', 'CBM']);
    }
    const category = findCategory(candidates);
    if (category === null) return;
    quantities[category] += 1;
    for (const [label, value] of properties) {
      if (!label || !value || /名称|NAME|文件|FAMILY|MODEL/i.test(label)) continue;
      availableParameters[category].set(label, (availableParameters[category].get(label) || 0) + 1);
    }
  };
  const nodes = collectNodes(state.currentCbmTree);
  // Read in bounded parallel batches: considerably faster than thousands of
  // serial File.text() calls without creating an equally large promise spike.
  for (let offset = 0; offset < nodes.length; offset += 100) {
    await Promise.all(nodes.slice(offset, offset + 100).map(processNode));
  }

  const priority = /电压|容量|电流|功率|变比|准确|开断|电阻|电感|电容|频率|冷却|绝缘|防护/;
  return EQUIPMENT_CATALOG.map((item, index) => {
    const detected = Array.from(availableParameters[index]).sort((a, b) => Number(priority.test(b[0])) - Number(priority.test(a[0])) || b[1] - a[1]).map(([name]) => name);
    return { name: item.name, keyParameters: Array.from(new Set([...detected.slice(0, 4), ...item.defaults, ...COMMON_PARAMETERS])).slice(0, 4), quantity: quantities[index] };
  });
}

export function getEquipmentInventory(state: AppState): Promise<EquipmentInventoryRow[]> {
  if (!state.currentFiles) return buildInventory(state);
  let result = inventoryCache.get(state.currentFiles);
  if (!result) { result = buildInventory(state); inventoryCache.set(state.currentFiles, result); }
  return result;
}

export const EQUIPMENT_CATEGORY_COUNT = EQUIPMENT_CATALOG.length;
