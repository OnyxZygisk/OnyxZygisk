## v1.09 - WebUI rebuilt on React, and a versionCode that finally moves

*   **WebUI rebuilt from scratch on React 19 + Vite + Tailwind CSS 4**, replacing the Vue 3 frontend: a strictly monochrome design system (hierarchy from type, weight, hairlines, surface level and spacing, never from hue), five tabs (Status / Modules / FN / Logs / Settings), and a new interface-scale setting.
*   The Status tab now leads the runtime section with one plain word — Working / Stopped / Checking / Installed, not running / Unknown — with the raw monitor rows underneath as the evidence, so a partially healthy system reads as exactly that instead of collapsing into one coloured badge.
*   Added three build-time guards that scan the compiled output rather than the sources: no chromatic value can reach the stylesheet; every i18n key the sources use exists in `en.xml`; and the development bridge cannot reach a release bundle.
*   Added Playwright behaviour and axe accessibility suites (light, dark and amoled), replacing Vitest.
*   Module authors are credited in the WebUI About section.
*   **Fixed the released `versionCode`**: the android job cloned shallowly, so `git rev-list HEAD --count` returned 1 and every release archive shipped `versionCode=4` (the v1.08 asset is literally named `OnyxZygisk-v1.08-4-ebae065-release.zip`). Root managers compare that value, so a release cut without the fix would have reported the same number as v1.08 and never been offered as an update.
*   Fixed the android job aborting before compilation on the SDK package Google removed, by moving to `android-actions/setup-android@v4`.
*   Fixed a `webuiBuild` input that declared `package-lock.json` while the project uses pnpm; Gradle validates declared inputs before running a task, so the module zip build would have failed.

## v1.08 - ReZygisk compatibility and Magisk FN modules

* Added ReZygisk-compatible `SIGPIPE` protection for the daemon and companion processes.
* Added a best-effort `FileDescriptorInfo::ReopenOrDetach` hook for stale root-overlay file descriptors.
* Improved KernelSU Next detection, Waydroid fallback handling, Private Space manager UID matching, and `ksud` path compatibility.
* Added Samsung Android B Zygote JNI signature support.
* Added standard Magisk-installed FN modules with `fn.prop` discovery, native entry loading, and Magisk lifecycle ownership.
* Added a Magisk FN example package and validated the Zig loader core with Zig 0.14.1.

## 🧬 v1.1 - WebUI, FN Phase 2 & APatch Deep Adaptation 🧬

### 🌐 Built-in WebUI (manager app removed)
*   **WebUI replaces the Android manager app**: `zygiskd` now embeds an HTTP server (loopback `127.0.0.1:47654`, port overridable via `webui.port` / `--webui-port`) serving the management page and a JSON API — no companion app to install.
*   Pages: status dashboard, Zygisk module list, FN node management (list / toggle / install zip / remove), DenyList manager for the active root solution, APatch SuperKey & supercall console, logcat viewer.
*   The Android app (`app/`) and its Gradle configuration were removed.

### 🧩 FN (Functional Node) modules — phase 2 wired
*   **Loader injection (phase 2)**: FN entry libraries are now loaded into app processes and system_server by the loader, filtered by `trigger` (`app` / `system_server` / `zygote`) and `scope` / `apps` (allowlist / denylist, `pkg:sub` matching), ordered by `priority`. New `ReadFnModules` / `GetFnModuleDir` daemon actions.
*   **Script scheduling**: `post-fs-data.sh` runs at daemon start (`post_fs_data` trigger), `service.sh` at late-start (`boot` trigger); output is fed into the daemon log.
*   **Zip install**: `install_fn_node` validates the descriptor before touching disk, whitelists entries (no path traversal), applies the update flow in place, and sets script permissions.
*   Example node in `docs/examples/`.

### 🅰️ APatch comprehensive adaptation
*   `apd` detection via `/data/adb/ap/bin/apd` + robust `-V` parsing.
*   Real CSV parsing of `package_config` (quoted fields, malformed-row skipping, read retries) with **`to_uid` uid-range matching** for multi-user / work profiles.
*   Atomic config writes (tmp + rename, same as upstream `apd`); manager detection scans all user profiles.
*   **Kernel supercall interface** (`syscall 45`, `ver_and_cmd` handshake, `SuProfile`): grant/revoke root by uid range, list granted uids, query kernel safe mode, sync the kernel exclude list — driven from the WebUI with the SuperKey held in memory only.
*   Clean-namespace unmounting now covers all root overlay sources (`magisk`, `KSU`, `APatch`, `kpatch`).

### 🔧 Build & fixes
*   Fix `WORK_DIRECTORY` define mangling through the CMake → ninja pipeline on Windows hosts.

## 🧬 v1.0 - OnyxZygisk: A NeoZygisk Fork 🧬

First release of OnyxZygisk, forked from NeoZygisk v2.3 by JingMatrix.

### 🔄 Rebrand
*   **Full Rebrand**: Renamed the project from NeoZygisk to OnyxZygisk, including the module name, module ID (`onyxzygisk`), working directory (`/data/adb/onyxzygisk`), release artifacts, and all user-facing strings.

### ✨ New Features
*   **FN (Functional Node) Module Subsystem**: Added support for FN modules — declarative, scoped, hot-swappable extension units. See [docs/FN.md](../docs/FN.md) for the specification.
*   **OnyxZygisk Manager**: Added the official companion manager app (Android, Jetpack Compose + Material 3) in the `app/` directory.

## 🚀 v2.3 - Robustness & Improved Root Support 🚀

This release focuses on improving stability for older architectures, ensuring compatibility with the latest KernelSU interfaces.

### 🛠 KernelSU & Root Integration
*   **KernelSU Supercall Support**: Implemented the new `ioctl`-based supercall interface for KernelSU (v20000+). This replaces the deprecated `prctl` method, ensuring compatibility with the latest KernelSU versions.
*   **Relaxed Version Checks**: Version limits for KernelSU have been relaxed to support community variants, with warnings now issued in logs instead of strict enforcement.

### 📱 Android 12 & 32-bit Compatibility
*   **Direct FD Passing**: Migrated mount namespace transfers to use Unix domain sockets (`SCM_RIGHTS`). This resolves "Permission denied" errors (Errno 13) encountered on certain Android 12 (arm32) devices when accessing namespace paths via `/proc`.
*   **Ptrace Fallback Mechanism**: Introduced a fallback to `PTRACE_ATTACH` for kernels where `PTRACE_SEIZE` fails with an I/O error. This includes robust signal handling to ignore spurious "noise" signals during the injection process.
*   **Legacy Register Support**: Added support for `PTRACE_GETREGS` and `PTRACE_SETREGS` for 32-bit ARM devices that do not support modern regset interfaces.
*   **Path Correction**: Fixed the executable path for the 32-bit Zygote to correctly point to `/system/bin/app_process32`.

### 🐛 Bug Fixes & Internal Improvements
*   **Socket Communication Fix**: Resolved a critical buffer overwrite bug in `recv_fds` where control message validation was failing due to dummy data corruption.
*   **Improved Fossil Detection**: Enhanced the detection of suspicious "zygote fossils" by monitoring loop device mounts, improving the stealth and cleanliness of the environment.
*   **FD Sealing**: The daemon now gracefully ignores errors when adding seals to module file descriptors, improving compatibility with older or custom kernels that lack full sealing support.
*   **Protocol Synchronization**: Added status byte checks to the communication protocol to prevent stream desynchronization during namespace transfers.
