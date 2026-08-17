import type { AppState } from '../app/state.js';
import type { CbmNode } from '../gim/types.js';
import { parseFamSections } from '../gim/famParser.js';
import { parseKeyValue } from '../gim/cbmParser.js';
import { getNodeDisplayName } from '../gim/gimIndexer.js';

export interface EquipmentInventoryRow {
  name: string;
  category: string;
  keyParameters: string[];
  parameterDetails: EquipmentParameterDetail[];
  quantity: number;
}

export interface EquipmentParameterDetail {
  name: string;
  values: string[];
}

type DefaultProperty = { label: string; value: string };

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
  if (!files) return [];
  const textCache = new WeakMap<File, Promise<string>>();
  const groups = new Map<string, {
    name: string;
    category: string;
    quantity: number;
    parameters: Map<string, { count: number; values: Set<string> }>;
  }>();
  const nodes = collectDeviceNodes(state.currentCbmTree);

  const processNode = async (node: CbmNode): Promise<void> => {
    const properties = await collectNodeDefaultProperties(node, files, textCache);
    const devFile = resolveFile(files, node.devPath, ['DEV']);
    const dev = devFile ? parseKeyValue(await getFileText(devFile.file, textCache)) : {};
    // 使用层级树设备层对应 FAM“型号/MODEL”作为名称，而不再使用
    // “设备名称”（如“高压开关柜”）进行模糊归类。
    const propertyName = properties.find(({ label }) => /^(?:型号|模型|MODEL)$/i.test(label))?.value;
    const name = propertyName?.trim()
      || dev.SYMBOLNAME?.trim()
      || getNodeDisplayName(node, state.ifcGuidToName).trim()
      || node.name
      || '未命名设备';
    const defaultCategory = properties.find(({ label }) => /^(?:类型|类别|CATEGORY|FAMILYNAME)$/i.test(label))?.value;
    const category = defaultCategory?.trim() || dev.TYPE?.trim() || node.entityName || '未分类';
    const groupKey = `${name}\u0000${category}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = { name, category, quantity: 0, parameters: new Map() };
      groups.set(groupKey, group);
    }
    group.quantity += 1;
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
