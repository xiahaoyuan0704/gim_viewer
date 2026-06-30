import type { CbmNode } from './types.js';

/** 解析 KEY=VALUE 格式文本 */
export function parseKeyValue(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx > 0) result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

function parseKeyValues(text: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    const values = result.get(key);
    if (values) values.push(value); else result.set(key, [value]);
  }
  return result;
}

function latest(kv: Map<string, string[]>, key: string): string {
  const values = kv.get(key);
  return values?.[values.length - 1] ?? '';
}

function values(kv: Map<string, string[]>, key: string): string[] {
  return kv.get(key) ?? [];
}

function indexedValues(kv: Map<string, string[]>, countKey: string, keyPrefixes: string[]): string[] {
  const result: string[] = [];
  const count = Number(latest(kv, countKey) || 0);
  for (let i = 0; i < count; i++) {
    for (const prefix of keyPrefixes) {
      const value = latest(kv, `${prefix}${i}`);
      if (value) { result.push(value); break; }
    }
  }
  return result;
}

function makePathIndex(files: Map<string, File>): Map<string, string> {
  const index = new Map<string, string>();
  for (const path of files.keys()) index.set(path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase(), path);
  return index;
}

function resolvePath(pathIndex: Map<string, string>, folder: string, ref: string): string | null {
  const wanted = `${folder}/${ref}`.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  const exact = pathIndex.get(wanted);
  if (exact) return exact;
  const fileName = ref.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
  if (!fileName) return null;
  for (const [key, original] of pathIndex) {
    if ((key.endsWith(`/${fileName}`) || key === fileName) && key.includes(`${folder.toLowerCase()}/`)) return original;
  }
  return null;
}

/** 从文件集合递归构建 CBM 层级树 */
export async function buildCbmTree(files: Map<string, File>): Promise<CbmNode | null> {
  const visited = new Set<string>();
  const pathIndex = makePathIndex(files);
  async function build(p: string): Promise<CbmNode | null> {
    const resolved = pathIndex.get(p.toLowerCase()) ?? p;
    if (visited.has(resolved)) return null; visited.add(resolved);
    const f = files.get(resolved); if (!f) return null;
    const kv = parseKeyValues(await f.text());
    const en = latest(kv, 'ENTITYNAME');
    const cn = latest(kv, 'SYSCLASSIFYNAME') || latest(kv, 'PARTNAME');
    const dn = cn || en || resolved.split('/').pop()!;
    const children: CbmNode[] = [];
    const childRefs = [
      ...values(kv, 'SUBSYSTEM'),
      ...indexedValues(kv, 'SUBSYSTEMS.NUM', ['SUBSYSTEM']),
      ...indexedValues(kv, 'SUBDEVICES.NUM', ['SUBDEVICES', 'SUBDEVICE']),
    ];
    for (const ref of childRefs) {
      const childPath = resolvePath(pathIndex, 'CBM', ref);
      if (!childPath) continue;
      const c = await build(childPath);
      if (c) children.push(c);
    }
    return {
      path: resolved,
      name: dn,
      entityName: en,
      children,
      famPath: latest(kv, 'BASEFAMILY'),
      devPath: latest(kv, 'OBJECTMODELPOINTER'),
      ifcFile: latest(kv, 'IFCFILE'),
      ifcGuid: latest(kv, 'IFCGUID').replace(/\$+$/, '').trim(),
      classifyName: cn,
      transformMatrix: latest(kv, 'TRANSFORMMATRIX'),
    };
  }
  const root = pathIndex.get('cbm/project.cbm');
  if (!root) return null;
  return build(root);
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
