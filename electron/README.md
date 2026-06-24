# Electron 桌面入口

本目录包含 GIM 阅读器桌面软件的 Electron 外壳。

- `main.cjs`：创建主窗口、加载开发服务或 `dist/index.html`、配置原生菜单。
- `preload.cjs`：通过 `contextBridge` 暴露安全的桌面菜单事件给渲染进程。

运行软件：

```bash
npm install
npm run dev
```

打包软件：

```bash
npm run build
```
