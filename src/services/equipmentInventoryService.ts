import type { AppState } from '../app/state.js';
import type { CbmNode } from '../gim/types.js';
import { parseFamSections } from '../gim/famParser.js';
import { parseKeyValue } from '../gim/cbmParser.js';
import { getNodeDisplayName } from '../gim/gimIndexer.js';

export interface EquipmentInventoryRow {
  name: string;
  category: string;
  subdeviceQuantity: number;
  keyParameters: string[];
  parameterDetails: EquipmentParameterDetail[];
  quantity: number;
}

export interface EquipmentParameterDetail {
  name: string;
  values: string[];
}

type DefaultProperty = { label: string; value: string };
type CatalogItem = { name: string; aliases?: string[] };

/** 附录 B 的 51 类电气设备；清单只允许输出这些类别。 */
const ELECTRICAL_EQUIPMENT_CATALOG: CatalogItem[] = [
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
  { name: '耦合电容器' },
  { name: '直流电压测量装置' },
  { name: '组合电器GIS', aliases: ['GIS组合电器', 'GIS设备', 'GIS'] },
  { name: '组合电器HGIS', aliases: ['HGIS组合电器', 'HGIS设备', 'HGIS'] },
  { name: '交流滤波器断路器', aliases: ['交流滤波器开关'] },
  { name: '交流直流断路器', aliases: ['交直流断路器'] },
  { name: '直流旁路开关' },
  { name: '直流转换开关' },
  { name: '交流隔离开关' },
  { name: '交流接地开关' },
  { name: '直流隔离开关' },
  { name: '直流接地开关' },
  { name: '换流阀' },
  { name: '消弧线圈-接地变压器成套装置', aliases: ['消弧线圈', '接地变压器成套装置'] },
  { name: '接地电阻成套装置' },
  { name: '中性点成套设备', aliases: ['中性点成套装置'] },
  { name: '隔直装置' },
  { name: '框架式电容器组' },
  { name: '集合式电容器组' },
  { name: '串补电容器成套装置', aliases: ['串联补偿电容器成套装置'] },
  { name: '降压式SVG' },
  { name: '直挂式SVG' },
  { name: 'SVC', aliases: ['静止无功补偿装置', '静止无功补偿器'] },
  { name: '滤波器电容器' },
  { name: '直流耦合电容器' },
  { name: '电阻器' },
  { name: '高压开关柜', aliases: ['主变柜', '出线柜', '进线柜', '电容器柜', '站用变柜', '10kV柜'] },
  { name: '低压开关柜' },
  { name: '熔断器' },
  { name: '避雷器' },
  { name: '直流避雷器-滤波避雷器', aliases: ['直流避雷器', '滤波避雷器'] },
  { name: '交流支柱绝缘子' },
  { name: '直流支柱绝缘子' },
  { name: '交流穿墙套管', aliases: ['穿墙套管'] },
  { name: '直流穿墙套管' },
  { name: '二次屏柜', aliases: ['保护屏柜', '控制屏柜', '保护屏', '控制屏', 'UPS电源屏', '电源屏'] },
  { name: '线路故障测量装置' },
  { name: '蓄电池组' },
  { name: '预制舱体' },
  { name: '安防设备' },
  { name: '火灾报警设备' },
];

const inventoryCache = new WeakMap<Map<string, File>, Promise<EquipmentInventoryRow[]>>();

function normalizeMatchText(value: string): string {
  return value.toUpperCase().replace(/[\s_\-—－（）()\/·*:.：，,]/g, '');
}

/** 名称允许存在电压、厂家、型号等前后缀，以最长命中的标准类别为准。 */
function findElectricalCatalogIndex(parts: string[]): number | null {
  const searchable = normalizeMatchText(parts.join(' '));
  let bestIndex = -1;
  let bestLength = 0;
  ELECTRICAL_EQUIPMENT_CATALOG.forEach((item, index) => {
    for (const candidate of [item.name, ...(item.aliases || [])]) {
      const token = normalizeMatchText(candidate);
      if (token && searchable.includes(token) && token.length > bestLength) {
        bestIndex = index;
        bestLength = token.length;
      }
    }
  });
  return bestIndex >= 0 ? bestIndex : null;
}

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
    // 清单只导出第四层级设备（F4System）。第五层级 PartIndex 仅作为
    // 该设备的从属子设备计数，不能再单独成为一条设备记录。
    if (node.entityName.toUpperCase() === 'F4SYSTEM') result.push(node);
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

async function collectFamSectionProperties(
  files: Map<string, File>,
  famRef: string | undefined,
  dirs: string[],
  textCache: WeakMap<File, Promise<string>>,
  sectionName: string,
  visited = new Set<string>(),
): Promise<DefaultProperty[]> {
  const resolved = resolveFile(files, famRef, dirs);
  if (!resolved || visited.has(resolved.path.toLowerCase())) return [];
  visited.add(resolved.path.toLowerCase());
  const text = await getFileText(resolved.file, textCache);
  const kv = parseKeyValue(text);
  const inherited = kv.BASEFAMILY
    ? await collectFamSectionProperties(files, kv.BASEFAMILY, dirs, textCache, sectionName, visited)
    : [];
  const sections = parseFamSections(text);
  const section = Array.from(sections).find(([name]) => name.trim() === sectionName)?.[1];
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

async function collectNodeSectionProperties(
  node: CbmNode,
  files: Map<string, File>,
  textCache: WeakMap<File, Promise<string>>,
  sectionName: string,
): Promise<DefaultProperty[]> {
  const properties: DefaultProperty[] = [];
  properties.push(...await collectFamSectionProperties(files, node.famPath, ['CBM', 'FAM'], textCache, sectionName));
  const devFile = resolveFile(files, node.devPath, ['DEV']);
  if (devFile) {
    const dev = parseKeyValue(await getFileText(devFile.file, textCache));
    properties.push(...await collectFamSectionProperties(files, dev.BASEFAMILY, ['DEV', 'FAM', 'CBM'], textCache, sectionName));
  }
  const seen = new Set<string>();
  return properties.filter((property) => {
    const key = `${property.label}=${property.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function collectEquipmentContext(
  node: CbmNode,
  files: Map<string, File>,
  textCache: WeakMap<File, Promise<string>>,
): Promise<{
  properties: DefaultProperty[];
  primaryProperties: DefaultProperty[];
  primaryDev: Record<string, string>;
  matchParts: string[];
}> {
  // 第四层级可能只保存组织信息，真正的设计参数位于直属第五层级，
  // 因此分类和明细属性要同时读取设备本身及其所有直属子设备。
  const members = [node, ...node.children];
  const properties: DefaultProperty[] = [];
  let primaryProperties: DefaultProperty[] = [];
  let primaryDev: Record<string, string> = {};
  const primaryMatchParts = [node.name, node.classifyName, node.entityName];
  const childMatchParts: string[] = [];
  for (const member of members) {
    const defaultProperties = await collectNodeSectionProperties(member, files, textCache, '默认');
    const designProperties = await collectNodeSectionProperties(member, files, textCache, '设计参数');
    // Excel 明细页只输出属性面板“设计参数”卡片中已经解析出的内容。
    properties.push(...designProperties);
    if (member === node) primaryProperties = [...defaultProperties, ...designProperties];
    const target = member === node ? primaryMatchParts : childMatchParts;
    target.push(member.name, member.classifyName, member.entityName);
    target.push(...[...defaultProperties, ...designProperties].flatMap(({ label, value }) => [label, value]));
    const devFile = resolveFile(files, member.devPath, ['DEV']);
    if (devFile) {
      const dev = parseKeyValue(await getFileText(devFile.file, textCache));
      if (member === node) primaryDev = dev;
      target.push(dev.SYMBOLNAME || '', dev.TYPE || '');
    }
  }
  const seen = new Set<string>();
  const uniqueProperties = properties.filter(({ label, value }) => {
    const key = `${label}\u0000${value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // 父设备自身信息优先，只有父级无法识别时才使用第五层级属性补充判断，
  // 避免某个“电阻器”等子部件反过来改变整台设备的类别。
  const matchParts = findElectricalCatalogIndex(primaryMatchParts) === null
    ? [...primaryMatchParts, ...childMatchParts]
    : primaryMatchParts;
  return { properties: uniqueProperties, primaryProperties, primaryDev, matchParts };
}

async function buildInventory(state: AppState): Promise<EquipmentInventoryRow[]> {
  const files = state.currentFiles;
  if (!files) return [];
  const textCache = new WeakMap<File, Promise<string>>();
  const groups = new Map<string, {
    name: string;
    category: string;
    quantity: number;
    subdeviceQuantity: number;
    parameters: Map<string, { count: number; values: Set<string> }>;
  }>();
  const nodes = collectDeviceNodes(state.currentCbmTree);

  const processNode = async (node: CbmNode): Promise<void> => {
    const { properties, primaryProperties, primaryDev, matchParts } = await collectEquipmentContext(node, files, textCache);
    matchParts.push(getNodeDisplayName(node, state.ifcGuidToName));
    const catalogIndex = findElectricalCatalogIndex(matchParts);
    if (catalogIndex === null) return;
    // 标准目录仅用于判定它是否属于电气设备；Excel 中仍输出第四层级的
    // 实际工程名称，而不是把名称替换为目录中的标准类别。
    const propertyName = primaryProperties.find(({ label }) => /^(?:型号|模型|MODEL)$/i.test(label))?.value;
    const name = propertyName?.trim()
      || primaryDev.SYMBOLNAME?.trim()
      || getNodeDisplayName(node, state.ifcGuidToName).trim()
      || node.name
      || ELECTRICAL_EQUIPMENT_CATALOG[catalogIndex].name;
    const propertyCategory = primaryProperties.find(({ label }) => /^(?:类型|类别|CATEGORY|FAMILYNAME)$/i.test(label))?.value;
    const category = propertyCategory?.trim() || primaryDev.TYPE?.trim() || ELECTRICAL_EQUIPMENT_CATALOG[catalogIndex].name;
    const groupKey = `${name}\u0000${category}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = { name, category, quantity: 0, subdeviceQuantity: 0, parameters: new Map() };
      groups.set(groupKey, group);
    }
    group.quantity += 1;
    // 第四层级节点的直接子节点即第五层级从属子设备。
    group.subdeviceQuantity += node.children.length;
    for (const { label, value } of properties) {
      let parameter = group.parameters.get(label);
      if (!parameter) {
        parameter = { count: 0, values: new Set<string>() };
        group.parameters.set(label, parameter);
      }
      parameter.count += 1;
      if (value && value !== '—' && value !== '-') parameter.values.add(value);
    }
  };

  for (let offset = 0; offset < nodes.length; offset += 100) {
    await Promise.all(nodes.slice(offset, offset + 100).map(processNode));
  }

  return Array.from(groups.values()).map((group) => {
    const parameters = Array.from(group.parameters)
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0], 'zh-CN'));
    return {
      name: group.name,
      category: group.category,
      quantity: group.quantity,
      subdeviceQuantity: group.subdeviceQuantity,
      keyParameters: parameters.map(([parameter]) => parameter),
      parameterDetails: parameters.map(([name, parameter]) => ({
        name,
        values: Array.from(parameter.values).sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true })),
      })),
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
    || a.category.localeCompare(b.category, 'zh-CN', { numeric: true }));
}

export function getEquipmentInventory(state: AppState): Promise<EquipmentInventoryRow[]> {
  if (!state.currentFiles) return buildInventory(state);
  let result = inventoryCache.get(state.currentFiles);
  if (!result) { result = buildInventory(state); inventoryCache.set(state.currentFiles, result); }
  return result;
}
