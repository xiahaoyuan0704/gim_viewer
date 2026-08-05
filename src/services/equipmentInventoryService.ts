import type { AppState } from '../app/state.js';
import type { CbmNode } from '../gim/types.js';
import { parseFamSections } from '../gim/famParser.js';
import { parseKeyValue } from '../gim/cbmParser.js';
import { getNodeDisplayName } from '../gim/gimIndexer.js';

export interface EquipmentInventoryRow {
  name: string;
  keyParameters: string[];
  quantity: number;
}

type CatalogItem = { name: string; aliases?: string[] };
type DefaultProperty = { label: string; value: string };

/** 设备名称列固定按原始清单输出；数量由第五层级设备名称匹配统计。 */
const EQUIPMENT_CATALOG: CatalogItem[] = [
  { name: '油浸式变压器' },
  { name: '干式变压器' },
  { name: '换流变压器' },
  { name: '油浸式电抗器' },
  { name: '干式电抗器' },
  { name: '电磁式电流互感器', aliases: ['电流互感器'] },
  { name: '电子式电流互感器' },
  { name: '电磁式电压互感器' },
  { name: '电容式电压互感器' },
  { name: '电子式电压互感器' },
  { name: '组合电器' },
  { name: '直流电压测量装置' },
  { name: '组合电器GIS', aliases: ['GIS组合电器', 'GIS'] },
  { name: '组合电器HGIS', aliases: ['HGIS组合电器', 'HGIS'] },
  { name: '交流滤波器' },
  { name: '直流滤波器' },
  { name: '交流避雷器' },
  { name: '直流旁路开关' },
  { name: '交流隔离开关' },
  { name: '交流接地开关' },
  { name: '直流隔离开关' },
  { name: '直流接地开关' },
  { name: '换流阀' },
  { name: '消弧线圈/接地变压器成套装置', aliases: ['消弧线圈', '接地变压器成套装置'] },
  { name: '接地电阻成套装置' },
  { name: '中性点成套设备', aliases: ['中性点成套装置'] },
  { name: '隔直装置' },
  { name: '框架式电容器组' },
  { name: '集合式电容器组' },
  { name: '串补电容器成套装置', aliases: ['串补电容器', '串联补偿装置'] },
  { name: '降压式SVG' },
  { name: '直挂式SVG' },
  { name: 'SVC', aliases: ['静止无功补偿器'] },
  { name: '滤波器电容器' },
  { name: '直流耦合电容器' },
  { name: '电阻器' },
  { name: '高压开关柜' },
  { name: '低压开关柜' },
  { name: '熔断器' },
  { name: '避雷器' },
  { name: '直流避雷器/滤波器', aliases: ['直流避雷器'] },
  { name: '交流支柱绝缘子', aliases: ['支柱绝缘子'] },
  { name: '直流支柱绝缘子' },
  { name: '交流穿墙套管', aliases: ['穿墙套管'] },
  { name: '直流穿墙套管' },
  { name: '平波电抗器' },
  { name: '线路故障测量装置' },
  { name: '蓄电池组' },
  { name: '预制舱体' },
  { name: '安防设备' },
  { name: '火灾报警设备' },
];

function normalizeName(value: string): string {
  return value.toUpperCase().replace(/[\s_\-—（）()\/·*]/g, '');
}

function findCatalogIndex(deviceName: string): number | null {
  const normalized = normalizeName(deviceName);
  let bestIndex = -1;
  let bestLength = 0;
  EQUIPMENT_CATALOG.forEach((item, index) => {
    for (const candidate of [item.name, ...(item.aliases || [])]) {
      const token = normalizeName(candidate);
      if (token && normalized.includes(token) && token.length > bestLength) {
        bestIndex = index;
        bestLength = token.length;
      }
    }
  });
  return bestIndex >= 0 ? bestIndex : null;
}

const inventoryCache = new WeakMap<Map<string, File>, Promise<EquipmentInventoryRow[]>>();

function normalizeRef(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/?(?:CBM|DEV|FAM)\//i, '').replace(/\$+$/, '').trim();
}

function resolveFile(files: Map<string, File>, ref: string | undefined, dirs: string[]): { path: string; file: File } | null {
  if (!ref) return null;
  const clean = normalizeRef(ref);
  if (!clean) return null;
  const candidates = [ref.replace(/\\/g, '/'), clean, ...dirs.map((dir) => `${dir}/${clean}`)];
  for (const candidate of candidates) {
    const exact = files.get(candidate);
    if (exact) return { path: candidate, file: exact };
    const lower = candidate.toLowerCase();
    for (const [path, file] of files) if (path.toLowerCase() === lower) return { path, file };
  }
  const fileName = clean.split('/').pop()?.toLowerCase();
  if (!fileName) return null;
  for (const [path, file] of files) if (path.split('/').pop()?.toLowerCase() === fileName) return { path, file };
  return null;
}

function collectDeviceNodes(root: CbmNode | null): CbmNode[] {
  const result: CbmNode[] = [];
  const walk = (node: CbmNode) => {
    // 设备清单只统计层级树中的设备节点（例如“10kV穿墙套管模型01”这一层），
    // 系统/间隔/工程等上级节点不参与数量统计。
    if (node.devPath) result.push(node);
    for (const child of node.children) walk(child);
  };
  if (root) walk(root);
  return result;
}

function parseFamValue(key: string, value: string): { label: string; value: string } {
  const separator = value.indexOf('=');
  return separator > 0
    ? { label: value.slice(0, separator).trim(), value: value.slice(separator + 1).trim() }
    : { label: key.trim(), value: value.trim() };
}

function shouldKeepDefaultParameter(label: string, value: string): boolean {
  if (!label || !value) return false;
  if (/\.(?:fam|cbm|dev|phm|mod)$/i.test(value.replace(/\$+$/, '').trim())) return false;
  if (/^(?:MODEL|FAMILYNAME)$/i.test(label)) return true;
  return !/文件|FAMILY|BASEFAMILY|REF|PATH/i.test(label);
}

async function collectDefaultProperties(
  files: Map<string, File>,
  famRef: string | undefined,
  dirs: string[],
  textCache: WeakMap<File, Promise<string>>,
  visited = new Set<string>(),
): Promise<DefaultProperty[]> {
  const resolved = resolveFile(files, famRef, dirs);
  if (!resolved || visited.has(resolved.path.toLowerCase())) return [];
  visited.add(resolved.path.toLowerCase());
  const text = await getFileText(resolved.file, textCache);
  const kv = parseKeyValue(text);
  const inherited = kv.BASEFAMILY ? await collectDefaultProperties(files, kv.BASEFAMILY, dirs, textCache, visited) : [];
  const section = parseFamSections(text).get('默认');
  const own: DefaultProperty[] = [];
  if (section) {
    for (const [key, raw] of section) {
      const decoded = parseFamValue(key, raw);
      if (shouldKeepDefaultParameter(decoded.label, decoded.value)) own.push(decoded);
    }
  }
  return [...inherited, ...own];
}

function getFileText(file: File, cache: WeakMap<File, Promise<string>>): Promise<string> {
  let text = cache.get(file);
  if (!text) {
    text = file.text();
    cache.set(file, text);
  }
  return text;
}

async function collectNodeDefaultProperties(node: CbmNode, files: Map<string, File>, textCache: WeakMap<File, Promise<string>>): Promise<DefaultProperty[]> {
  const properties: DefaultProperty[] = [];
  properties.push(...await collectDefaultProperties(files, node.famPath, ['CBM', 'FAM'], textCache));
  const devFile = resolveFile(files, node.devPath, ['DEV']);
  if (devFile) {
    const dev = parseKeyValue(await getFileText(devFile.file, textCache));
    properties.push(...await collectDefaultProperties(files, dev.BASEFAMILY, ['DEV', 'FAM', 'CBM'], textCache));
  }
  const seen = new Set<string>();
  return properties.filter((property) => {
    const key = `${property.label}=${property.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function buildInventory(state: AppState): Promise<EquipmentInventoryRow[]> {
  const files = state.currentFiles;
  const rows = EQUIPMENT_CATALOG.map(({ name }) => ({ name, keyParameters: [] as string[], quantity: 0 }));
  if (!files) return rows;
  const textCache = new WeakMap<File, Promise<string>>();
  const parametersByCatalog = EQUIPMENT_CATALOG.map(() => new Map<string, number>());
  const nodes = collectDeviceNodes(state.currentCbmTree);

  const processNode = async (node: CbmNode): Promise<void> => {
    const properties = await collectNodeDefaultProperties(node, files, textCache);
    const deviceName = getNodeDisplayName(node, state.ifcGuidToName).trim() || node.name || node.classifyName || '未命名设备';
    const catalogIndex = findCatalogIndex([
      deviceName,
      node.name,
      node.classifyName,
      node.entityName,
      ...properties.flatMap((property) => [property.label, property.value]),
    ].join(' '));
    if (catalogIndex === null) return;
    rows[catalogIndex].quantity += 1;
    for (const { label } of properties) {
      const bucket = parametersByCatalog[catalogIndex];
      bucket.set(label, (bucket.get(label) || 0) + 1);
    }
  };

  for (let offset = 0; offset < nodes.length; offset += 100) {
    await Promise.all(nodes.slice(offset, offset + 100).map(processNode));
  }

  return rows.map((row, index) => ({
    ...row,
    keyParameters: Array.from(parametersByCatalog[index])
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
      .map(([parameter]) => parameter),
  }));
}

export function getEquipmentInventory(state: AppState): Promise<EquipmentInventoryRow[]> {
  if (!state.currentFiles) return buildInventory(state);
  let result = inventoryCache.get(state.currentFiles);
  if (!result) { result = buildInventory(state); inventoryCache.set(state.currentFiles, result); }
  return result;
}
