import type { AppState } from '../app/state.js';
import { parseKeyValue } from '../gim/cbmParser.js';

export type ProjectScaleRow = { label: string; value: string };

const STATION_FIELDS: Array<{ label: string; aliases: string[] }> = [
  { label: '工程名称', aliases: ['工程名称', '项目名称', '工程名', 'PROJECTNAME'] },
  { label: '设计阶段', aliases: ['设计阶段', '设计阶段名称', 'DESIGNSTAGE'] },
  { label: '电压等级', aliases: ['电压等级', '电压等级名称', 'VOLTAGELEVEL'] },
  { label: '主变压器规模', aliases: ['主变压器规模', '主变规模', '主变容量', 'MAINTRANSFORMERSCALE'] },
  { label: '高压侧出线规模', aliases: ['高压侧出线规模', '高压出线规模', 'HIGHVOLTAGEOUTGOINGSCALE'] },
  { label: '中压侧出线规模', aliases: ['中压侧出线规模', '中压出线规模', 'MEDIUMVOLTAGEOUTGOINGSCALE'] },
  { label: '低压侧出线规模', aliases: ['低压侧出线规模', '低压出线规模', 'LOWVOLTAGEOUTGOINGSCALE'] },
  { label: '高压侧主接线方式(远期/本期)', aliases: ['高压侧主接线方式(远期/本期)', '高压侧主接线方式', 'HIGHVOLTAGEWIRING'] },
  { label: '中压侧主接线方式(远期/本期)', aliases: ['中压侧主接线方式(远期/本期)', '中压侧主接线方式', 'MEDIUMVOLTAGEWIRING'] },
  { label: '低压侧主接线方式(远期/本期)', aliases: ['低压侧主接线方式(远期/本期)', '低压侧主接线方式', 'LOWVOLTAGEWIRING'] },
];
const scaleCache = new WeakMap<Map<string, File>, Promise<ProjectScaleRow[]>>();

function normalizeKey(key: string): string { return key.toUpperCase().replace(/[\s_\-()（）]/g, ''); }
function findPath(files: Map<string, File>, ref: string, preferredDir = 'CBM'): string | null {
  const direct = `${preferredDir}/${ref}`;
  if (files.has(direct)) return direct;
  const lower = ref.toLowerCase();
  for (const path of files.keys()) if (path.toLowerCase().endsWith(`/${lower}`)) return path;
  return null;
}

/** 仅读取工程入口及其 FAM 继承链，避免点击按钮时遍历数千个设备属性文件。 */
async function readSubstationScale(files: Map<string, File>): Promise<ProjectScaleRow[]> {
  const values = new Map<string, string>();
  const visited = new Set<string>();
  const collect = async (path: string | null): Promise<void> => {
    if (!path || visited.has(path)) return;
    visited.add(path);
    const file = files.get(path); if (!file) return;
    const properties = parseKeyValue(await file.text());
    for (const [key, value] of Object.entries(properties)) if (value && !values.has(normalizeKey(key))) values.set(normalizeKey(key), value);
    const parent = properties.BASEFAMILY;
    if (parent) await collect(findPath(files, parent, path.startsWith('DEV/') ? 'DEV' : 'CBM'));
  };
  await collect(files.has('CBM/project.cbm') ? 'CBM/project.cbm' : null);
  // 工程属性文件通常位于 CBM 根目录；只读取名称明确的候选文件，不扫描设备 FAM。
  for (const path of files.keys()) if (/^CBM\/.*(?:工程属性|工程信息|project|项目).*\.fam$/i.test(path)) await collect(path);
  return STATION_FIELDS.map(({ label, aliases }) => ({ label, value: aliases.map(normalizeKey).map((key) => values.get(key)).find(Boolean) || '—' }));
}

export function getSubstationScale(state: AppState): Promise<ProjectScaleRow[]> {
  if (!state.currentFiles) return Promise.resolve(STATION_FIELDS.map(({ label }) => ({ label, value: '—' })));
  let result = scaleCache.get(state.currentFiles);
  if (!result) { result = readSubstationScale(state.currentFiles); scaleCache.set(state.currentFiles, result); }
  return result;
}
