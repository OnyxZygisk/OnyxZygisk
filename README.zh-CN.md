<div align="center">

<img src="assets/tux.png" alt="OnyxZygisk" width="128">

# OnyxZygisk

**开箱即用的 Zygisk 运行时 —— 全 Root 方案通用。**

基于 ptrace 的 Zygisk 实现，内置 WebUI、可热插拔的 FN 模块和进阶 DenyList。无需内核模块。

[![Telegram](https://img.shields.io/badge/Telegram-OnyxZygisk-2CA5E0?logo=telegram&logoColor=white)](https://t.me/OnyxZygisk)
[![Release](https://img.shields.io/github/v/release/OnyxZygisk/OnyxZygisk?label=最新版&color=brightgreen)](https://github.com/OnyxZygisk/OnyxZygisk/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

[English](README.md) · **简体中文** · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md)

</div>

---

## 为什么选择 OnyxZygisk？

### Root 方案无关

开箱兼容 **APatch**、**KernelSU**（含 LKM 延迟加载）和 **Magisk**。更换 Root 方案无需更换 Zygisk —— 一个模块全部搞定。

### 零重启工作流

- **热插拔** —— 启用或禁用 Zygisk 模块无需重启。
- **FN 模块** —— 声明式、按作用域、可热插拔的扩展节点，下次应用启动即刻生效。[了解更多 →](docs/FN.md)

### 内置 WebUI

基于 Vue 3 + Vite + TypeScript 构建的完整控制面板，由 KernelSU / APatch Manager / MMRL 本地读取 —— 无需网络端口，无需服务进程。仪表盘、模块列表、FN 管理、logcat 查看器。浅色 / 深色 / 纯黑主题。[了解更多 →](docs/WEBUI.md)

### 进阶隐藏

双层 DenyList，让 Root 痕迹对检测类应用完全不可见：

| 策略 | 工作原理 |
| :--- | :--- |
| **Zygote 卸载**（主策略） | 在应用进程 specialize *之前*，从 zygote 剥离 root 与模块挂载。 |
| **命名空间切换**（回退） | fork 后通过 `setns` 将应用移入缓存好的、完全干净的挂载命名空间。 |

`/proc/self/maps` 无痕迹、无泄漏的挂载点、无残留的文件描述符。

### 纯用户态，无内核模块

纯 ptrace 注入 —— 无需构建、维护或在内核更新后修复自定义内核模块。支持所有启用 `PTRACE_SEIZE` 的内核。

---

## 快速上手

### 安装

从[最新 Release](https://github.com/OnyxZygisk/OnyxZygisk/releases/latest) 下载 zip，在 Root 管理器（APatch / KernelSU / Magisk）中刷入并重启。

### 配置 DenyList

| Root 方案 | 操作位置 |
| :--- | :--- |
| **APatch / KernelSU** | 为目标应用启用 **卸载模块** |
| **Magisk** | **配置 DenyList**（保持 Magisk 自带的"强制 DenyList"**关闭**） |

### 打开 WebUI

在 KernelSU Manager、APatch Manager 或 MMRL 中打开模块页面，点击 **WebUI**。

---

## 从源码构建

```sh
git clone https://github.com/OnyxZygisk/OnyxZygisk.git
cd OnyxZygisk
./gradlew :module:zipRelease
```

可刷入的 zip 输出到 `module/build/outputs/release/`。

---

## 社区

[![Telegram Channel](https://img.shields.io/badge/Telegram-OnyxZygisk-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white)](https://t.me/OnyxZygisk)

加入 Telegram 频道，获取版本发布公告、讨论与技术支持。

---

## 致谢

OnyxZygisk 基于以下项目构建并受其启发：

- **Zygisk API** —— [topjohnwu](https://github.com/topjohnwu) / [Magisk](https://github.com/topjohnwu/Magisk)
- **Zygisk Next** —— [Dr-TSNG](https://github.com/Dr-TSNG/ZygiskNext)
- **NeoZygisk** —— [JingMatrix](https://github.com/JingMatrix/NeoZygisk)
- **OnyxZygisk** —— Sai, Matsuzaka Yuki 与[贡献者们](https://github.com/OnyxZygisk/OnyxZygisk/graphs/contributors)

## 许可证

[AGPL-3.0](LICENSE)。OnyxZygisk 是 NeoZygisk (GPL-3.0) 的下游，集成了 CSOLoader (AGPL-3.0) 作为进程内自定义模块加载器；依据 GPL-3.0 §13，组合作品以 AGPL-3.0 发布。上游 GPL-3.0 声明保留 —— 详见 [NOTICE.md](NOTICE.md)。
