const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gimDesktop', {
  openGimFile: () => ipcRenderer.invoke('gim:open-file'),
  onOpenGimFileRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('gim:menu-open', listener);
    return () => ipcRenderer.removeListener('gim:menu-open', listener);
  },
  platform: process.platform,
});
