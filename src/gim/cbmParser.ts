import type { CbmNode } from './types.js';

export interface KeyValueEntry { key: string; value: string }

/** 解析 KEY=VALUE 格式文本，保留顺序和重复键 */
export function parseKeyValueEntries(text: string): KeyValueEntry[] {
  const entries: KeyValueEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx > 0) entries.push({ key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() });
  }
  return entries;
}

/** 解析 KEY=VALUE 格式文本。重复键会保留最后一个值，兼容旧调用点。 */
export function parseKeyValue(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const { key, value } of parseKeyValueEntries(text)) result[key] = value;
  return result;
}

export function valuesAfterCount(entries: KeyValueEntry[], countKey: string, valuePrefix: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].key !== countKey) continue;
    const count = Number.parseInt(entries[i].value || '0', 10);
    if (!Number.isFinite(count) || count <= 0) continue;
    for (let j = i + 1; j < entries.length && out.length < count; j++) {
      if (entries[j].key.toUpperCase().startsWith(valuePrefix.toUpperCase())) out.push(entries[j].value);
    }
  }
  return out;
}

function addUnique(out: string[], value: string | undefined): void {
  if (value && !out.includes(value)) out.push(value);
}

function resolveCbmRoot(files: Map<string, File>): string | null {
  if (files.has('CBM/project.cbm')) return 'CBM/project.cbm';
  const cbms = Array.from(files.keys()).filter((p) => /^CBM\/[^/]+\.cbm$/i.test(p));
  return cbms.length === 1 ? cbms[0] : null;
}

/** 从文件集合递归构建 CBM 层级树 */
export async function buildCbmTree(files: Map<string, File>): Promise<CbmNode | null> {
  const visited = new Set<string>();
  async function build(p: string): Promise<CbmNode | null> {
    if (visited.has(p)) return null; visited.add(p);
    const f = files.get(p); if (!f) return null;
    const text = await f.text();
    const kv = parseKeyValue(text);
    const entries = parseKeyValueEntries(text);
    const en = kv['ENTITYNAME'] || '';
    const cn = kv['SYSCLASSIFYNAME'] || kv['PARTNAME'] || '';
    const dn = cn || en || p.split('/').pop()!;
    const children: CbmNode[] = [];
    const childRefs: string[] = [];
    addUnique(childRefs, kv['SUBSYSTEM']);
    for (const ref of valuesAfterCount(entries, 'SUBSYSTEMS.NUM', 'SUBSYSTEM')) addUnique(childRefs, ref);
    for (const ref of valuesAfterCount(entries, 'SUBDEVICES.NUM', 'SUBDEVICE')) addUnique(childRefs, ref);
    for (const s of childRefs) { const c = await build(`CBM/${s}`); if (c) children.push(c); }
    return { path: p, name: dn, entityName: en, children, famPath: kv['BASEFAMILY'] || '', devPath: kv['OBJECTMODELPOINTER'] || '', ifcFile: kv['IFCFILE'] || '', ifcGuid: (kv['IFCGUID'] || '').replace(/\$+$/, '').trim(), classifyName: cn, transformMatrix: kv['TRANSFORMMATRIX'] || '' };
  }
  const root = resolveCbmRoot(files);
  return root ? build(root) : null;
}

/** 构建 CBM 文件名 → CbmNode 索引 */
export function buildCbmNodeIndex(node: CbmNode | null): Map<string, CbmNode> {
  const index = new Map<string, CbmNode>();
  function walk(n: CbmNode) {
    const fileName = n.path.split('/').pop() || '';
    if (fileName) index.set(fileName, n);
    for (const child of n.children) walk(child);
  }
  if (node) walk(node);
  return index;
}

/** 收集节点及其后代的所有 IFC 引用 → Map<modelId, Set<ifcGuid>> */
export function collectIfcRefs(node: CbmNode): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  function walk(n: CbmNode) {
    if (n.ifcFile && n.ifcGuid) {
      const modelId = n.ifcFile.replace(/\.ifc$/i, '');
      if (!refs.has(modelId)) refs.set(modelId, new Set());
      refs.get(modelId)!.add(n.ifcGuid);
    }
    for (const child of n.children) walk(child);
  }
  walk(node);
  return refs;
}
