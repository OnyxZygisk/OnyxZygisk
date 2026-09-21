# OnyxZygisk WebUI

OnyxZygisk 的 WebUI 遵循 **KernelSU 模块 WebUI 规范**：静态页面放在模块的
`webroot/` 目录，由根管理应用（KernelSU Manager / APatch Manager / MMRL）的
WebView 直接读取——**不监听任何网络端口，不依赖 TCP**，守护进程完全不参与
页面传输。

WebUI 基于 **React 19 + Vite + Tailwind CSS 4** 构建，源码在仓库的
`zygiskd/webui/`，构建产物由 Gradle 自动放入模块的 `webroot/`。

## 安装后的页面文件

```
/data/adb/modules/onyxzygisk/webroot/
├── index.html         # 入口（规范要求必须存在）
├── config.json        # 宿主读取的 WebUI 配置（标题、CSP、返回键拦截）
├── locales/           # 界面语言（XML 字符串表 + 语言清单）
└── assets/            # Vite 构建产物（js/css，路径相对化）
    ├── index-*.js
    └── style-*.css
```

## 打开方式

| 宿主 | 入口 |
|---|---|
| KernelSU Manager | 模块列表 → OnyxZygisk → WebUI |
| APatch Manager | 模块列表 → OnyxZygisk → WebUI |
| MMRL | 模块列表 → WebUI |

页面在普通浏览器里打开时（`pnpm dev`）会载入开发用的假数据，便于在没有
root 设备的机器上开发与测试。

## 工作原理（KernelSU 标准）

1. 静态页面由宿主的 WebView 加载（文件直读，无网络）。
2. 宿主向页面注入 JS bridge：
   - **KernelSU / APatch**：`window.ksu.exec(...)`，经 `kernelsu-alt` 调用；
   - **MMRL**：`window.mmrl.exec(...)`（Promise 或回调风格，页面防御性适配）。
3. 页面通过 bridge 执行 shell 读取/管理系统状态——状态、模块列表与 FN 节点
   列表来自一次脚本调用；FN 启用/禁用通过 `disable` 状态文件切换（下次 fork
   生效）。
4. shell 输出的非 ASCII 字节会被 bridge 破坏，因此 stdout 在 shell 侧做
   `base64` 包装、在页面侧按 UTF-8 解码；退出码单独保留，避免管道把失败的
   写操作变成假成功。

## 页面功能

五个标签页，均在一级导航中：

| 标签页 | 功能 |
|---|---|
| 状态 | 监控器 / 守护进程 / Root 方案 / 版本、zygote ABI、安装与运行时状态、工作目录、监控器原始状态行 |
| 模块 | `/data/adb/modules` 下的 Zygisk 模块列表（版本/作者/描述/启用状态），待生效更新的热插拔开关 |
| FN | FN 节点列表（trigger/scope/状态），启用/禁用 |
| 日志 | logcat 中 `zygiskd` / `zygisk-sh` 的日志，支持行数、自动刷新、过滤与复制 |
| 设置 | 外观（跟随系统 / 浅色 / 深色 / 纯黑）、语言、热插拔总开关、挂载模式、关于 |

模块源码目录下的 `?gallery` 查询参数会打开设计组件总览页，仅开发构建可用。

## 设计标准

界面是**严格单色**的：层次只由字号、字重、发丝线、表面层级与间距表达，
不使用任何彩色。完整规范见 `zygiskd/webui/DESIGN.md`。

三条构建期守卫（`tests/unit/`）保证规范不被绕过：

- `monochrome.test.mjs` 扫描**编译后的样式表**，任何彩色取值都会让构建失败，
  同时校验三套主题的 token 完整性与对比度；
- `i18n_keys.test.mjs` 校验源码用到的每个文案键都存在于 `en.xml`，且
  `en.xml` 与 `zh-CN.xml` 的键集合一致；
- `bundle.test.mjs` 校验"伪造设备状态"的开发 bridge 不会进入正式构建。

## 构建与测试

源码位于 `zygiskd/webui/`，是一个标准的 Vite 工程：

```sh
cd zygiskd/webui
pnpm install              # 首次（Gradle 构建时会自动执行 pnpm install --frozen-lockfile）
pnpm dev                  # 开发预览：PC 浏览器 + 假数据，热更新
pnpm run build            # 类型检查（tsc）+ 产物到 dist/
pnpm test                 # 单元守卫（node --test，需先 build）
pnpm exec playwright test # 行为与可访问性测试（Playwright + axe）
pnpm check:biome          # Biome 格式与 lint 检查（只读）
pnpm lint                 # Biome 格式化并修复
```

模块 zip 构建时 Gradle 的 `webuiBuild` 任务会自动执行 `pnpm run build`，
并把 `dist/` 打包进 `webroot/`（依赖 pnpm + Node.js ≥ 20，首次构建自动
`pnpm install --frozen-lockfile`）。

> **注意**：`webroot/` 是构建产物，修改源码后必须重新 `pnpm run build`
> 并重新打包模块才会生效；不要直接编辑安装后的 `webroot/`。

## 与既有实现的关系

早期版本由 `zygiskd` 提供 loopback TCP HTTP 服务（端口 47654）作为访问通道。
按 KernelSU 标准，该通道已移除：**静态文件直读 + JS bridge** 是生态内唯一
标准方式，也避免了 SELinux 对 TCP 监听的额外权限需求。

再早的版本是手写 ES modules（无构建步骤），可直接编辑 webroot 生效。

之后曾用 **Vue 3 + vue-tsc + Vitest + ESLint/Prettier** 重写。当前版本改用
**React 19 + Vite + Tailwind CSS 4 + Headless UI + Biome + Playwright**，
与同组织的其他模块 WebUI 保持同一套技术栈与测试标准；同时把配色收敛为
严格单色——此前由绿色主色、四种状态色和逐主题手工维护的调色板承担的信息，
现在由字重、glyph 与表面层级表达，并在构建期由守卫拦截回归。
