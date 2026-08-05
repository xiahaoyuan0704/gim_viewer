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

async function collectDefaultParameterNames(
  files: Map<string, File>,
  famRef: string | undefined,
  dirs: string[],
  textCache: WeakMap<File, Promise<string>>,
  visited = new Set<string>(),
): Promise<string[]> {
  const resolved = resolveFile(files, famRef, dirs);
  if (!resolved || visited.has(resolved.path.toLowerCase())) return [];
  visited.add(resolved.path.toLowerCase());
  const text = await getFileText(resolved.file, textCache);
  const kv = parseKeyValue(text);
  const inherited = kv.BASEFAMILY ? await collectDefaultParameterNames(files, kv.BASEFAMILY, dirs, textCache, visited) : [];
  const section = parseFamSections(text).get('默认');
  const own: string[] = [];
  if (section) {
    for (const [key, raw] of section) {
      const decoded = parseFamValue(key, raw);
      if (shouldKeepDefaultParameter(decoded.label, decoded.value)) own.push(decoded.label);
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

async function collectNodeDefaultParameters(node: CbmNode, files: Map<string, File>, textCache: WeakMap<File, Promise<string>>): Promise<string[]> {
  const parameters: string[] = [];
  parameters.push(...await collectDefaultParameterNames(files, node.famPath, ['CBM', 'FAM'], textCache));
  const devFile = resolveFile(files, node.devPath, ['DEV']);
  if (devFile) {
    const dev = parseKeyValue(await getFileText(devFile.file, textCache));
    parameters.push(...await collectDefaultParameterNames(files, dev.BASEFAMILY, ['DEV', 'FAM', 'CBM'], textCache));
  }
  return Array.from(new Set(parameters));
}

async function buildInventory(state: AppState): Promise<EquipmentInventoryRow[]> {
  const files = state.currentFiles;
  if (!files) return [];
  const textCache = new WeakMap<File, Promise<string>>();
  const groups = new Map<string, { quantity: number; parameters: Map<string, number> }>();
  const nodes = collectDeviceNodes(state.currentCbmTree);

  const processNode = async (node: CbmNode): Promise<void> => {
    const name = getNodeDisplayName(node, state.ifcGuidToName).trim() || node.name || node.classifyName || '未命名设备';
    const group = groups.get(name) || { quantity: 0, parameters: new Map<string, number>() };
    group.quantity += 1;
    groups.set(name, group);
    for (const parameter of await collectNodeDefaultParameters(node, files, textCache)) {
      group.parameters.set(parameter, (group.parameters.get(parameter) || 0) + 1);
    }
  };

  for (let offset = 0; offset < nodes.length; offset += 100) {
    await Promise.all(nodes.slice(offset, offset + 100).map(processNode));
  }

  return Array.from(groups, ([name, group]) => ({
    name,
    keyParameters: Array.from(group.parameters).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN')).map(([parameter]) => parameter),
    quantity: group.quantity,
  })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
}

export function getEquipmentInventory(state: AppState): Promise<EquipmentInventoryRow[]> {
  if (!state.currentFiles) return buildInventory(state);
  let result = inventoryCache.get(state.currentFiles);
  if (!result) { result = buildInventory(state); inventoryCache.set(state.currentFiles, result); }
  return result;
}
