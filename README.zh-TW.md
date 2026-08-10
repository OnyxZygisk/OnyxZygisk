<div align="center">

<img src="assets/tux.png" alt="OnyxZygisk" width="128">

# OnyxZygisk

**開箱即用的 Zygisk 執行環境 —— 全 Root 方案通用。**

基於 ptrace 的 Zygisk 實作，內建 WebUI、可熱抽換的 FN 模組和進階 DenyList。無需核心模組。

[![Telegram](https://img.shields.io/badge/Telegram-OnyxZygisk-2CA5E0?logo=telegram&logoColor=white)](https://t.me/OnyxZygisk)
[![Release](https://img.shields.io/github/v/release/OnyxZygisk/OnyxZygisk?label=最新版&color=brightgreen)](https://github.com/OnyxZygisk/OnyxZygisk/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

[English](README.md) · [简体中文](README.zh-CN.md) · **繁體中文** · [日本語](README.ja.md)

</div>

---

## 為什麼選擇 OnyxZygisk？

### Root 方案無關

開箱相容 **APatch**、**KernelSU**（含 LKM 延遲載入）和 **Magisk**。更換 Root 方案無需更換 Zygisk —— 一個模組全部搞定。

### 零重啟工作流

- **熱插拔** —— 啟用或停用 Zygisk 模組無需重新開機。
- **FN 模組** —— 宣告式、依作用域、可熱抽換的擴充節點，下次應用啟動即刻生效。[了解更多 →](docs/FN.md)

### 內建 WebUI

基於 Vue 3 + Vite + TypeScript 建置的完整控制面板，由 KernelSU / APatch Manager / MMRL 本機讀取 —— 無需網路連接埠，無需伺服器行程。儀表板、模組清單、FN 管理、logcat 檢視器。淺色 / 深色 / 純黑佈景主題。[了解更多 →](docs/WEBUI.md)

### 進階隱藏

雙層 DenyList，讓 Root 痕跡對偵測類應用完全不可見：

| 策略 | 工作原理 |
| :--- | :--- |
| **Zygote 卸載**（主策略） | 在應用行程 specialize *之前*，從 zygote 剝離 root 與模組掛載。 |
| **命名空間切換**（回退） | fork 後透過 `setns` 將應用移入快取好的、完全乾淨的掛載命名空間。 |

`/proc/self/maps` 無痕跡、無洩漏的掛載點、無殘留的檔案描述符。

### 純使用者態，無核心模組

純 ptrace 注入 —— 無需建置、維護或在核心更新後修復自訂核心模組。支援所有啟用 `PTRACE_SEIZE` 的核心。

---

## 快速上手

### 安裝

從[最新 Release](https://github.com/OnyxZygisk/OnyxZygisk/releases/latest) 下載 zip，在 Root 管理器（APatch / KernelSU / Magisk）中刷入並重新開機。

### 設定 DenyList

| Root 方案 | 操作位置 |
| :--- | :--- |
| **APatch / KernelSU** | 為目標應用啟用 **卸載模組** |
| **Magisk** | **設定 DenyList**（保持 Magisk 內建的「強制 DenyList」**關閉**） |

### 開啟 WebUI

在 KernelSU Manager、APatch Manager 或 MMRL 中開啟模組頁面，點選 **WebUI**。

---

## 從原始碼建置

```sh
git clone https://github.com/OnyxZygisk/OnyxZygisk.git
cd OnyxZygisk
./gradlew :module:zipRelease
```

可刷入的 zip 輸出到 `module/build/outputs/release/`。

---

## 社群

[![Telegram Channel](https://img.shields.io/badge/Telegram-OnyxZygisk-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white)](https://t.me/OnyxZygisk)

加入 Telegram 頻道，取得版本發佈公告、討論與技術支援。

---

## 致謝

OnyxZygisk 基於以下專案建置並受其啟發：

- **Zygisk API** —— [topjohnwu](https://github.com/topjohnwu) / [Magisk](https://github.com/topjohnwu/Magisk)
- **Zygisk Next** —— [Dr-TSNG](https://github.com/Dr-TSNG/ZygiskNext)
- **NeoZygisk** —— [JingMatrix](https://github.com/JingMatrix/NeoZygisk)
- **OnyxZygisk** —— Sai, Matsuzaka Yuki 與[貢獻者們](https://github.com/OnyxZygisk/OnyxZygisk/graphs/contributors)

## 授權條款

[AGPL-3.0](LICENSE)。OnyxZygisk 是 NeoZygisk (GPL-3.0) 的下游，整合了 CSOLoader (AGPL-3.0) 作為行程內自訂模組載入器；依據 GPL-3.0 §13，組合作品以 AGPL-3.0 發佈。上游 GPL-3.0 聲明保留 —— 詳見 [NOTICE.md](NOTICE.md)。
