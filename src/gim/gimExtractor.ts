import type { GimHeaderInfo } from './types.js';

let archiveInitialized = false;

async function getArchive() {
  const mod = await import('libarchive.js');
  if (!archiveInitialized) {
    mod.Archive.init({ workerUrl: 'worker-bundle.js' });
    archiveInitialized = true;
  }
  return mod.Archive;
}

/** GIM 固定长度头部布局（单位：字节）。 */
const GIM_HEADER_LAYOUT = [
  ['文件标识', 16], ['文件名称', 256], ['文件编辑者', 64], ['文件编辑单位', 256],
  ['软件名称', 128], ['创建时间', 16], ['软件主版本号', 8], ['软件次版本号', 8],
  ['标准主版本号', 8], ['标准次版本号', 8], ['存储域大小', 16],
] as const;
const GIM_HEADER_SIZE = GIM_HEADER_LAYOUT.reduce((total, [, size]) => total + size, 0);
const GIM_SIGNATURES = new Set(['GIMPKGS', 'GIMPKGT', 'GIMPKEC']);

function readHeaderText(bytes: Uint8Array): string {
  const decode = (encoding: string) => new TextDecoder(encoding, { fatal: false }).decode(bytes)
    .replace(/\0/g, '').trim();
  const utf8 = decode('utf-8');
  // 工程文件常用 UTF-8；对于旧版 GBK 头部，在 UTF-8 产生替换字符时回退。
  return utf8.includes('�') ? decode('gbk') : utf8;
}

function getGimSignature(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return readHeaderText(bytes.slice(0, 16)).slice(0, 7);
}

/** 在 ArrayBuffer 中搜索 7z 或 ZIP 签名的偏移量。 */
export function findArchiveOffset(buffer: ArrayBuffer): number {
  const v = new Uint8Array(buffer);
  if (v.length < GIM_HEADER_SIZE || !GIM_SIGNATURES.has(getGimSignature(buffer))) return 0;
  // 固定头部之后即为压缩数据；同时保留签名扫描来兼容有填充的历史文件。
  for (let i = GIM_HEADER_SIZE; i < Math.min(v.length, 4096) - 5; i++) {
    if (v[i] === 0x37 && v[i + 1] === 0x7a && v[i + 2] === 0xbc && v[i + 3] === 0xaf && v[i + 4] === 0x27 && v[i + 5] === 0x1c) return i;
    if (v[i] === 0x50 && v[i + 1] === 0x4b && v[i + 2] === 0x03 && v[i + 3] === 0x04) return i;
  }
  return 0;
}

/** 按 GIM 标准的固定字段布局读取 GIM 文件头。 */
export function parseGimHeader(arrayBuffer: ArrayBuffer, selectedFileName: string): GimHeaderInfo {
  const bytes = new Uint8Array(arrayBuffer);
  const signature = getGimSignature(arrayBuffer);
  const hasGimHeader = GIM_SIGNATURES.has(signature);
  const archiveOffset = findArchiveOffset(arrayBuffer);
  const archiveSignature = archiveOffset > 0 ? bytes.slice(archiveOffset, archiveOffset + 6) : new Uint8Array();
  const archiveFormat = archiveSignature[0] === 0x37 && archiveSignature[1] === 0x7a ? '7z' : archiveSignature[0] === 0x50 && archiveSignature[1] === 0x4b ? 'ZIP' : '未知';
  const fields: Array<{ key: string; value: string }> = [];
  let offset = 0;
  for (const [key, size] of GIM_HEADER_LAYOUT) {
    const value = bytes.length >= offset + size ? readHeaderText(bytes.slice(offset, offset + size)) : '';
    fields.push({ key, value: key === '文件名称' ? value || selectedFileName : value || '—' });
    offset += size;
  }
  return { fileName: selectedFileName, fileSize: bytes.byteLength, hasGimHeader, archiveOffset, archiveFormat, fields };
}

/** 将 libarchive.js 解压结果展平为 Map<path, File> */
export function flattenExtractedFiles(obj: unknown, prefix = ''): Map<string, File> {
  const result = new Map<string, File>();
  if (!obj || typeof obj !== 'object') return result;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}/${key}` : key;
    if (value instanceof File) result.set(path, value);
    else if (value && typeof value === 'object') for (const [sp, sf] of flattenExtractedFiles(value, path)) result.set(sp, sf);
  }
  return result;
}

/** 解压 GIM 文件，返回展平后的文件 Map */
export async function extractGimFile(arrayBuffer: ArrayBuffer): Promise<Map<string, File>> {
  const offset = findArchiveOffset(arrayBuffer);
  const ab = offset > 0 ? arrayBuffer.slice(offset) : arrayBuffer;
  const blob = new Blob([ab]);
  const file = new File([blob], 'archive', { type: 'application/octet-stream' });
  const Archive = await getArchive();
  const archive = await Archive.open(file);
  const extracted = await archive.extractFiles();
  await archive.close();
  return flattenExtractedFiles(extracted);
}
