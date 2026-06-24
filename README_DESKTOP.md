# GIM 阅读器桌面软件

本项目现在按“桌面软件优先”运行：用户无需手动打开浏览器，`npm run dev` 会自动启动本地渲染服务并打开 Electron 软件窗口。

## 第一次运行

```bash
npm install
npm run dev
```

`npm run dev` 会完成两件事：

1. 启动 Vite 渲染服务，供 Electron 窗口加载界面资源。
2. 自动打开 GIM 阅读器桌面窗口。

## 日常运行

```bash
npm run dev
```

也可以使用等价命令：

```bash
npm start
```

## 打包软件

```bash
npm run build
```

该命令会先执行 TypeScript 与 Vite 构建，再调用 electron-builder 生成安装包。产物输出到 `release/` 目录。

如果只想生成未压缩的软件目录，便于本机快速验证：

```bash
npm run pack
```

## 软件功能

- 打开 GIM 文件并解析压缩包、CBM 层级、文件设备关系。
- 选择并加载 GIM 中的 IFC 模型。
- 直接打开本地 IFC 文件。
- 浏览 CBM 层级树、文件设备面板、属性抽屉。
- 支持 3D 点击拾取、构件高亮、相机定位和属性联动。
- 原生菜单提供“打开 GIM 文件”“打开 IFC 文件”“清空场景”等入口。

## 常见问题

### 提示找不到 Electron

请先执行：

```bash
npm install
```

如果 npm 下载较慢，可以切换镜像后重试：

```bash
npm config set registry https://registry.npmmirror.com
npm install
```

### 想打开开发者工具

macOS / Linux：

```bash
ELECTRON_OPEN_DEVTOOLS=1 npm run dev
```

Windows PowerShell：

```powershell
$env:ELECTRON_OPEN_DEVTOOLS="1"
npm run dev
```
