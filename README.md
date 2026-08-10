<div align="center">

<img src="assets/tux.png" alt="OnyxZygisk" width="128">

# OnyxZygisk

**The Zygisk runtime that just works — on every root.**

A ptrace-powered Zygisk implementation with a built-in WebUI, hot-swappable FN modules, and an advanced DenyList. No kernel module required.

[![Telegram](https://img.shields.io/badge/Telegram-OnyxZygisk-2CA5E0?logo=telegram&logoColor=white)](https://t.me/OnyxZygisk)
[![Release](https://img.shields.io/github/v/release/OnyxZygisk/OnyxZygisk?label=Latest&color=brightgreen)](https://github.com/OnyxZygisk/OnyxZygisk/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

**English** · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md)

</div>

---

## Why OnyxZygisk?

### Root-agnostic

Works out of the box on **APatch**, **KernelSU** (including LKM late-load), and **Magisk**. Switch root solutions without switching your Zygisk — one module covers them all.

### Zero-reboot workflow

- **Hot-plug** — enable or disable Zygisk modules without rebooting.
- **FN modules** — declarative, scoped, hot-swappable extension nodes that take effect on the next app launch. [Learn more →](docs/FN.md)

### Built-in WebUI

A full control panel built with Vue 3 + Vite + TypeScript, served locally by KernelSU / APatch Manager / MMRL — no network port, no server process. Dashboard, module list, FN management, logcat viewer. Light / Dark / AMOLED themes. [Learn more →](docs/WEBUI.md)

### Advanced stealth

A two-layer DenyList that keeps root invisible to detection-hardened apps:

| Strategy | How it works |
| :--- | :--- |
| **Zygote unmount** (primary) | Strips root and module mounts from zygote *before* the app process is specialised. |
| **Namespace switch** (fallback) | Moves the forked app into a cached, completely clean mount namespace via `setns`. |

No traces in `/proc/self/maps`, no leaked mount points, no stale file descriptors.

### Userspace-only, no kernel module

Pure ptrace injection — no custom kernel module to build, maintain, or break on kernel updates. Works on any kernel that supports `PTRACE_SEIZE`.

---

## Quick start

### Install

Flash the zip from the [latest release](https://github.com/OnyxZygisk/OnyxZygisk/releases/latest) in your root manager (APatch / KernelSU / Magisk) and reboot.

### Configure the DenyList

| Root solution | Where to enable |
| :--- | :--- |
| **APatch / KernelSU** | Enable **Umount modules** for the target app |
| **Magisk** | **Configure DenyList** (keep Magisk's own *Enforce DenyList* **off**) |

### Open the WebUI

Open the module page in KernelSU Manager, APatch Manager, or MMRL and tap **WebUI**.

---

## Build from source

```sh
git clone https://github.com/OnyxZygisk/OnyxZygisk.git
cd OnyxZygisk
./gradlew :module:zipRelease
```

The flashable zip is written to `module/build/outputs/release/`.

---

## Community

[![Telegram Channel](https://img.shields.io/badge/Telegram-OnyxZygisk-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white)](https://t.me/OnyxZygisk)

Join the Telegram channel for release announcements, discussion, and support.

---

## Credits

OnyxZygisk is built on and inspired by:

- **Zygisk API** — [topjohnwu](https://github.com/topjohnwu) / [Magisk](https://github.com/topjohnwu/Magisk)
- **Zygisk Next** — [Dr-TSNG](https://github.com/Dr-TSNG/ZygiskNext)
- **NeoZygisk** — [JingMatrix](https://github.com/JingMatrix/NeoZygisk)
- **OnyxZygisk** — Sai, Matsuzaka Yuki, and [contributors](https://github.com/OnyxZygisk/OnyxZygisk/graphs/contributors)

## License

[AGPL-3.0](LICENSE). OnyxZygisk is a downstream of NeoZygisk (GPL-3.0) and integrates CSOLoader (AGPL-3.0) as its in-process custom module loader; per GPL-3.0 §13 the combined work is conveyed under AGPL-3.0. Upstream GPL-3.0 notices are retained — see [NOTICE.md](NOTICE.md).
