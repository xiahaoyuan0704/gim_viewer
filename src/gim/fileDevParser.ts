import type { FileDevEntry } from './types.js';
import { parseKeyValue } from './cbmParser.js';

/** 解析 FileDevRelation.cbm */
export async function parseFileDevRelation(files: Map<string, File>): Promise<FileDevEntry[]> {
  const f = files.get('CBM/FileDevRelation.cbm');
  if (!f) return [];
  const kv = parseKeyValue(await f.text());
  const num = parseInt(kv['FILE.NUM'] || '0', 10);
  const entries: FileDevEntry[] = [];
  for (let i = 0; i < num; i++) {
    const ifcName = kv[`FILE${i}.NAME`] || '';
    const devNum = parseInt(kv[`FILE${i}.DEV.NUM`] || '0', 10);
    const deviceCbms: string[] = [];
    for (let j = 0; j < devNum; j++) {
      const dev = kv[`FILE${i}.DEV${j}`];
      if (dev) deviceCbms.push(dev);
    }
    // 标准格式在同一 FILE<i> 条目中给出 IFC；兼容历史导出中放在后一条目的写法。
    const ifcFile = kv[`FILE${i}.IFC`] || kv[`FILE${i + 1}.IFC`] || `${ifcName}.ifc`;
    const modelId = ifcFile.replace(/\.ifc$/i, '');
    entries.push({ ifcName, ifcFile, modelId, deviceCount: devNum, deviceCbms });
  }
  return entries;
}
