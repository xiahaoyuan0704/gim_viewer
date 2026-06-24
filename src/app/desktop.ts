type DesktopBridge = {
  onOpenGim?: (callback: () => void) => void;
  onOpenIfc?: (callback: () => void) => void;
  onClearScene?: (callback: () => void) => void;
  onAbout?: (callback: () => void) => void;
};

declare global {
  interface Window {
    gimDesktop?: DesktopBridge;
  }
}

/**
 * Electron 桌面端菜单桥接。
 * 网页端没有 window.gimDesktop 时会自动跳过，因此同一套 UI/业务逻辑可同时用于网页和桌面软件。
 */
export function setupDesktopBridge(): void {
  const bridge = window.gimDesktop;
  if (!bridge) return;

  bridge.onOpenGim?.(() => document.getElementById('gim-file-input')?.click());
  bridge.onOpenIfc?.(() => document.getElementById('file-input')?.click());
  bridge.onClearScene?.(() => document.getElementById('btn-clear')?.click());
  bridge.onAbout?.(() => {
    window.alert('GIM 阅读器\n桌面软件版本\n支持打开 GIM/IFC 文件、浏览 CBM 层级树、查看设备属性并联动 3D 模型。');
  });
}
