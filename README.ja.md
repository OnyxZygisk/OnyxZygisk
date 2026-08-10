<div align="center">

<img src="assets/tux.png" alt="OnyxZygisk" width="128">

# OnyxZygisk

**あらゆる Root でそのまま動く Zygisk ランタイム。**

ptrace ベースの Zygisk 実装。WebUI 内蔵、ホットスワップ対応の FN モジュール、高度な DenyList を搭載。カーネルモジュール不要。

[![Telegram](https://img.shields.io/badge/Telegram-OnyxZygisk-2CA5E0?logo=telegram&logoColor=white)](https://t.me/OnyxZygisk)
[![Release](https://img.shields.io/github/v/release/OnyxZygisk/OnyxZygisk?label=最新版&color=brightgreen)](https://github.com/OnyxZygisk/OnyxZygisk/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · **日本語**

</div>

---

## なぜ OnyxZygisk？

### Root 方式を問わない

**APatch**、**KernelSU**（LKM 遅延ロードを含む）、**Magisk** にそのまま対応。Root 方式を変えても Zygisk を変える必要はありません — ひとつのモジュールですべてカバー。

### 再起動不要のワークフロー

- **ホットプラグ** — Zygisk モジュールの有効化・無効化に再起動不要。
- **FN モジュール** — 宣言的・スコープ指定・ホットスワップ可能な拡張ノード。次のアプリ起動時にすぐ反映されます。[詳細 →](docs/FN.md)

### 内蔵 WebUI

Vue 3 + Vite + TypeScript で構築されたフル機能のコントロールパネル。KernelSU / APatch Manager / MMRL がローカルで読み取り — ネットワークポート不要、サーバープロセス不要。ダッシュボード、モジュール一覧、FN 管理、logcat ビューア。ライト / ダーク / AMOLED テーマ対応。[詳細 →](docs/WEBUI.md)

### 高度なステルス

二層構造の DenyList で、検出強化アプリから Root を完全に隠蔽：

| 戦略 | 仕組み |
| :--- | :--- |
| **Zygote アンマウント**（主戦略） | アプリプロセスが specialize される*前*に、zygote から root・モジュールのマウントを剥離。 |
| **名前空間切り替え**（フォールバック） | fork 後、`setns` でアプリをキャッシュ済みの完全クリーンなマウント名前空間へ移動。 |

`/proc/self/maps` に痕跡なし、マウントポイントの漏洩なし、ファイルディスクリプタの残留なし。

### ユーザー空間のみ、カーネルモジュール不要

純粋な ptrace インジェクション — カスタムカーネルモジュールのビルド・保守・カーネル更新時の修正が一切不要。`PTRACE_SEIZE` 対応のすべてのカーネルで動作します。

---

## クイックスタート

### インストール

[最新リリース](https://github.com/OnyxZygisk/OnyxZygisk/releases/latest)から zip をダウンロードし、Root マネージャー（APatch / KernelSU / Magisk）でフラッシュして再起動。

### DenyList の設定

| Root 方式 | 設定場所 |
| :--- | :--- |
| **APatch / KernelSU** | 対象アプリで **Umount modules** を有効化 |
| **Magisk** | **Configure DenyList**（Magisk 自身の「Enforce DenyList」は**オフ**のまま） |

### WebUI を開く

KernelSU Manager、APatch Manager、または MMRL でモジュールページを開き、**WebUI** をタップ。

---

## ソースからビルド

```sh
git clone https://github.com/OnyxZygisk/OnyxZygisk.git
cd OnyxZygisk
./gradlew :module:zipRelease
```

フラッシュ可能な zip は `module/build/outputs/release/` に出力されます。

---

## コミュニティ

[![Telegram Channel](https://img.shields.io/badge/Telegram-OnyxZygisk-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white)](https://t.me/OnyxZygisk)

Telegram チャンネルに参加して、リリース情報・ディスカッション・サポートを受け取りましょう。

---

## クレジット

OnyxZygisk は以下のプロジェクトの上に構築され、そこから着想を得ています：

- **Zygisk API** — [topjohnwu](https://github.com/topjohnwu) / [Magisk](https://github.com/topjohnwu/Magisk)
- **Zygisk Next** — [Dr-TSNG](https://github.com/Dr-TSNG/ZygiskNext)
- **NeoZygisk** — [JingMatrix](https://github.com/JingMatrix/NeoZygisk)
- **OnyxZygisk** — Sai, Matsuzaka Yuki および[コントリビューター](https://github.com/OnyxZygisk/OnyxZygisk/graphs/contributors)

## ライセンス

[AGPL-3.0](LICENSE)。OnyxZygisk は NeoZygisk (GPL-3.0) の下流であり、CSOLoader (AGPL-3.0) をインプロセスのカスタムモジュールローダーとして統合しています。GPL-3.0 §13 に基づき、結合著作物は AGPL-3.0 で頒布されます。上流の GPL-3.0 通知は保持されています — [NOTICE.md](NOTICE.md) を参照してください。
