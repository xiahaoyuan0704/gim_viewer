# 桌面软件入口

本目录包含 Electron 外壳，用于把现有 Vite/Web 版 GIM 阅读器打包成桌面软件。

- `main.cjs`：创建主窗口、加载开发服务器或 `dist/index.html`、配置原生菜单。
- `preload.cjs`：通过安全的 `contextBridge` 暴露菜单事件给渲染进程。

开发流程：

1. 终端 A 运行 `npm run dev` 启动 Vite。
2. 终端 B 运行 `npm run desktop:dev` 启动桌面窗口。

打包流程：运行 `npm run desktop:build`，产物输出到 `release/`。
