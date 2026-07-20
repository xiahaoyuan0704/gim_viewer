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

/** 在 ArrayBuffer 中搜索 7z 或 ZIP 签名的偏移量 */
export function findArchiveOffset(buffer: ArrayBuffer): number {
  const v = new Uint8Array(buffer);
  if (v.length < 8) return 0;
  if (String.fromCharCode(...v.slice(0, 7)) !== 'GIMPKGS') return 0;
  // 搜索 7z 签名
  for (let i = 7; i < Math.min(v.length, 4096) - 5; i++) {
    if (v[i] === 0x37 && v[i + 1] === 0x7a && v[i + 2] === 0xbc && v[i + 3] === 0xaf && v[i + 4] === 0x27 && v[i + 5] === 0x1c) return i;
  }
  // 搜索 ZIP 签名
  for (let i = 7; i < Math.min(v.length, 4096) - 3; i++) {
    if (v[i] === 0x50 && v[i + 1] === 0x4b && v[i + 2] === 0x03 && v[i + 3] === 0x04) return i;
  }
  return 0;
}


/** 读取 GIMPKGS 压缩数据之前的可读文件头信息。 */
export function parseGimHeader(arrayBuffer: ArrayBuffer, fileName: string): GimHeaderInfo {
  const bytes = new Uint8Array(arrayBuffer);
  const archiveOffset = findArchiveOffset(arrayBuffer);
  const hasGimHeader = bytes.length >= 7 && String.fromCharCode(...bytes.slice(0, 7)) === 'GIMPKGS';
  const signature = archiveOffset > 0 ? bytes.slice(archiveOffset, archiveOffset + 6) : new Uint8Array();
  const archiveFormat = signature[0] === 0x37 && signature[1] === 0x7a ? '7z' : signature[0] === 0x50 && signature[1] === 0x4b ? 'ZIP' : '未知';
  const prefixEnd = archiveOffset > 0 ? archiveOffset : Math.min(bytes.length, 4096);
  const rawText = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(7, prefixEnd))
    .replace(/\0/g, '\n').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]+/g, ' ').trim();
  const fields: Array<{ key: string; value: string }> = [
    { key: '文件名称', value: fileName },
    { key: '文件大小', value: `${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB` },
    { key: '文件签名', value: hasGimHeader ? 'GIMPKGS' : '未检测到 GIMPKGS 头' },
    { key: '压缩格式', value: archiveFormat },
    { key: '压缩数据偏移', value: archiveOffset > 0 ? `${archiveOffset} bytes` : '未定位' },
  ];
  for (const line of rawText.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key && value && key.length <= 48) fields.push({ key, value });
  }
  const readable = rawText.replace(/\s+/g, ' ').trim();
  if (readable && !fields.slice(5).length) fields.push({ key: '头部信息', value: readable.slice(0, 300) });
  return { fileName, fileSize: bytes.byteLength, hasGimHeader, archiveOffset, archiveFormat, fields };
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
