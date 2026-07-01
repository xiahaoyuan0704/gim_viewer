# GIM 桌面阅读器

基于 That Open Components、web-ifc、Three.js 和 libarchive.js 构建的国家电网 GIM（Grid Information Model）模型浏览器。应用既可以作为 Vite Web 应用运行，也提供 Electron 桌面端壳层，用于通过系统文件对话框打开本地 `.gim` 模型。

## 能力范围

- 解析国网 GIM 包：自动识别 `GIMPKGS` 头部，并定位内嵌 7z/ZIP 压缩数据。
- 解压并索引 `CBM/`、`DEV/`、`PHM/`、`MOD/` 等目录中的工程数据。
- 通过 `CBM/project.cbm` 构建工程层级树，并发现其中引用的 IFC 模型。
- 基于 `FileDevRelation.cbm` 建立 IFC 文件与设备节点之间的双向关系。
- 使用 That Open + web-ifc 加载 IFC 几何，支持模型列表、点击拾取、高亮、相机定位和属性查看。
- 在属性抽屉中展示 FAM 设计参数、DEV 设备信息、IFC 原生属性集等内容。
- Electron 桌面端支持原生文件选择窗口打开 `.gim` 文件。

> 说明：当前 3D 几何渲染仍以 GIM 包中引用的 IFC 文件为主；`MOD/`、`PHM/` 的专有几何/装配数据已随包解压并保留在索引中，可在后续版本继续扩展为原生 GIM 几何重建流程。

## 技术栈

- 3D/IFC：`@thatopen/components`、`@thatopen/fragments`、`web-ifc`、`three`
- GIM 解包：`libarchive.js` WebAssembly Worker
- 桌面端：Electron 主进程 + 安全 preload bridge
- 构建：Vite + TypeScript strict mode

## 开发命令

```bash
npm run dev          # 启动 Web 版 Vite 开发服务器
npm run build        # TypeScript 编译 + Vite 生产构建
npm run electron:dev # 构建前端并启动 Electron 桌面端
npm run desktop:pack # 生成 Electron 未打包目录
npm run desktop:dist # 生成平台安装包
```

如果需要运行桌面端命令，请确保本地能够安装 `electron` 和 `electron-builder`。在受限网络环境下，可能需要配置可访问的 npm 镜像源。

## 项目结构

```text
src/
  app/               应用启动与全局状态
  desktop/           Electron preload 暴露给渲染进程的类型和工具
  gim/               GIM 解压、CBM/DEV/FAM 等格式解析与索引
  services/          打开 GIM/IFC、加载模型等业务流程
  ui/                原生 DOM UI 组件
  viewer/            That Open / web-ifc 查看器、相机、选择和高亮逻辑
electron/
  main.cjs           Electron 主进程、窗口创建、系统文件对话框
  preload.cjs        安全暴露桌面 API
public/              web-ifc 与 libarchive 运行时 WASM/Worker
```

## GIM 解析流程

1. 读取 `.gim` 文件二进制。
2. 检测 `GIMPKGS` 文件头。
3. 扫描 7z (`37 7A BC AF 27 1C`) 或 ZIP (`50 4B 03 04`) 签名，定位压缩数据偏移。
4. 使用 libarchive.js 解压为文件树，并展平为 `Map<path, File>`。
5. 解析 `CBM/project.cbm` 构建工程层级树。
6. 扫描 CBM 引用或包内全部 IFC 文件，弹窗选择要加载的模型。
7. 使用 That Open / web-ifc 加载 IFC 并建立属性、名称和设备关联索引。

## 注意事项

- `public/worker-bundle.js`、`public/libarchive.wasm`、`public/web-ifc.wasm` 和 `public/web-ifc-mt.wasm` 是离线运行必需文件。
- 大型演示数据建议放在 `demo/`，并保持在 `.gitignore` 中排除。
- Electron 打包时会将 Vite `dist/` 与 `electron/` 目录一并纳入应用。
