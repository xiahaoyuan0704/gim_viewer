const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gimDesktop', {
  openGimFile: () => ipcRenderer.invoke('gim:open-file'),
  platform: process.platform,
});
