# GIM 阅读器桌面软件

项目现在保留原网页版本，并新增 Electron 桌面软件外壳。桌面版复用同一套 GIM 解析、IFC 加载、CBM 层级树、文件设备关系、3D 拾取和属性面板逻辑，因此功能和界面效果与网页版本保持一致。

## 开发运行

```bash
npm run dev
npm run desktop:dev
```

第一条命令启动 Vite 开发服务器，第二条命令启动 Electron 桌面窗口并加载开发服务器。

## 构建桌面安装包

```bash
npm run desktop:build
```

构建会先执行 TypeScript 和 Vite 构建，然后调用 electron-builder。产物输出到 `release/` 目录。

## 桌面端能力

- 原生窗口承载现有三栏式 GIM 阅读器界面。
- 菜单提供“打开 GIM 文件”“打开 IFC 文件”“清空场景”等入口。
- 支持 Windows、macOS、Linux 的 electron-builder 目标配置。
- 离线运行依赖的 `worker-bundle.js`、`libarchive.wasm`、`web-ifc.wasm`、`web-ifc-mt.wasm` 继续从 `public/` 复制到构建产物根目录。
