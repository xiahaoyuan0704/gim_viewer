export interface DesktopGimFile {
  name: string;
  path: string;
  data: Uint8Array | ArrayBuffer | number[];
}

export interface GimDesktopApi {
  openGimFile(): Promise<DesktopGimFile | null>;
  platform: string;
}

declare global {
  interface Window {
    gimDesktop?: GimDesktopApi;
  }
}

export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean(window.gimDesktop);
}

export function toArrayBuffer(data: DesktopGimFile['data']): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  const bytes = Array.isArray(data) ? new Uint8Array(data) : data;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
