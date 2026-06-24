const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gimDesktop', {
  onOpenGim: (callback) => ipcRenderer.on('app:open-gim', callback),
  onOpenIfc: (callback) => ipcRenderer.on('app:open-ifc', callback),
  onClearScene: (callback) => ipcRenderer.on('app:clear-scene', callback),
  onAbout: (callback) => ipcRenderer.on('app:about', callback),
});
