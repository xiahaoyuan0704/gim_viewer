const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const isDev = !app.isPackaged;

function createAppMenu(win) {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开 GIM 模型...',
          accelerator: process.platform === 'darwin' ? 'Command+O' : 'Ctrl+O',
          click: () => win.webContents.send('gim:menu-open'),
        },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit', label: process.platform === 'darwin' ? '关闭窗口' : '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    title: 'GIM 桌面阅读器',
    backgroundColor: '#edf4f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  createAppMenu(win);

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('gim:open-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '打开 GIM 模型',
    properties: ['openFile'],
    filters: [
      { name: 'GIM 模型', extensions: ['gim'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (canceled || filePaths.length === 0) return null;
  const filePath = filePaths[0];
  const data = await fs.readFile(filePath);
  return {
    name: path.basename(filePath),
    path: filePath,
    data,
  };
});
