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

function normalizeKey(key: string): string {
  return key.toUpperCase().replace(/[\s_\-()（）]/g, '');
}

/** 从工程属性相关文本中提取变电站工程规模字段。 */
export async function getSubstationScale(state: AppState): Promise<ProjectScaleRow[]> {
  if (!state.currentFiles) return STATION_FIELDS.map(({ label }) => ({ label, value: '—' }));
  const entries: Array<[string, Record<string, string>]> = [];
  const preferred = /(?:工程属性|工程信息|project|项目).*(?:\.fam|\.cbm)$/i;
  for (const [path, file] of state.currentFiles) {
    if (!/\.(fam|cbm)$/i.test(path)) continue;
    entries.push([path, parseKeyValue(await file.text())]);
  }
  entries.sort(([a], [b]) => Number(preferred.test(b)) - Number(preferred.test(a)) || a.localeCompare(b, 'zh-CN'));
  const values = new Map<string, string>();
  for (const [, properties] of entries) {
    for (const [key, value] of Object.entries(properties)) {
      if (value && !values.has(normalizeKey(key))) values.set(normalizeKey(key), value);
    }
  }
  return STATION_FIELDS.map(({ label, aliases }) => ({
    label,
    value: aliases.map(normalizeKey).map((key) => values.get(key)).find(Boolean) || '—',
  }));
}
