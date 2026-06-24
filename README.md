# GIM 阅读器桌面软件

GIM 阅读器是用于查看 GIM（Grid Information Model，电网信息模型）文件的桌面软件。软件基于 Electron 承载现有 3D 渲染与 GIM/IFC 解析能力，打开后就是独立窗口，不需要用户手动打开浏览器。

![alt text](static/image.png)

## 技术栈

- **桌面外壳**：Electron
- **3D 渲染**：[That Open](https://thatopen.com/) + [web-ifc](https://ifcjs.github.io/ifcjs-crash-course/) + Three.js
- **压缩包解压**：[libarchive.js](https://github.com/nika-begiashvili/libarchivejs)（WebAssembly，支持 7z/ZIP/RAR 等）
- **渲染构建**：Vite + TypeScript

## 功能

- 打开 `.gim` 文件，自动检测 GIMPKGS 头部并解压内部 7z/ZIP 数据。
- 通过 CBM 层级结构发现 IFC 文件，或直接扫描 DEV 目录。
- 选择性加载 IFC 文件（全选、取消全选、勾选指定文件）。
- 浏览 CBM 层级树和文件设备关系。
- 显示/隐藏已加载模型。
- 直接打开本地 IFC 文件。
- 3D 点击拾取构件、高亮构件、展示 IFC/GIM 属性。
- 原生菜单支持打开 GIM、打开 IFC、清空场景等操作。

## 快速开始

第一次运行：

```bash
npm install
npm run dev
```

之后日常启动软件：

```bash
npm run dev
```

`npm run dev` 会自动启动本地渲染服务并打开 Electron 桌面窗口。

## 打包软件

生成安装包或平台产物：

```bash
npm run build
```

产物输出到 `release/` 目录。

生成未压缩的软件目录，便于本机快速验证：

```bash
npm run pack
```

更多桌面端说明见 [README_DESKTOP.md](README_DESKTOP.md)。

## 安装失败排查

如果 `npm install` 在安装 Electron 时出现 `RequestError: read ECONNRESET`，通常是 Electron 二进制下载连接被重置。项目根目录已经提供 `.npmrc`，默认配置了 npm 镜像、Electron 镜像和 electron-builder 二进制镜像。

建议重新执行：

```bash
npm cache verify
npm install --no-audit --no-fund
```

Windows PowerShell 如仍失败，可临时指定镜像后重试：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm install --no-audit --no-fund --verbose
```

## GIM 文件格式

`.gim` 文件是国家电网的工程信息模型标准格式，本质是自定义头部 + 压缩包：

```
┌──────────────────────┐
│ GIMPKGS 头部（变长）    │  自定义头部，含项目编号和名称
├──────────────────────┤
│ 7z 或 ZIP 压缩数据     │  标准压缩格式
└──────────────────────┘
```

解压后包含四个目录：

| 目录 | 说明 | 主要文件类型 |
|------|------|-------------|
| CBM/ | 工程模型（层级骨架） | .cbm, .fam, .sch, .sld, .std |
| DEV/ | 物理设备模型 | .dev, .fam, **.ifc** |
| PHM/ | 组合模型（装配体） | .phm |
| MOD/ | 几何模型（基本图元） | .mod, .stl |

详细格式说明见 [doc/schema/](doc/schema/)，Demo 工程分析见 [doc/gim_spec.md](doc/gim_spec.md)。

## 项目结构

```
gim_viewer/
├── electron/                # Electron 主进程与 preload
├── public/                  # 静态资源与 WASM
│   ├── worker-bundle.js     # libarchive.js Worker
│   ├── libarchive.wasm      # libarchive WASM
│   ├── web-ifc.wasm         # web-ifc WASM
│   └── web-ifc-mt.wasm      # web-ifc 多线程 WASM
├── scripts/
│   └── desktop-dev.cjs      # 一键启动本地服务与 Electron 窗口
├── src/                     # 渲染进程业务代码
├── doc/                     # GIM/CBM/DEV/FAM 等格式说明
├── index.html               # Electron 渲染界面入口
├── vite.config.ts
├── tsconfig.json
└── package.json
```

## License

MIT
