/* OnyxZygisk — PC development fallback data.
 *
 * Only used when no bridge is present (plain browser / `npm run dev` / preview):
 * the UI renders with canned data so it can be developed without a rooted device.
 * The canned strings follow the current UI locale so the dev experience matches
 * the language switcher (see useLocale.currentLocale).
 */
import { currentLocale } from "../composables/useLocale";

/** Module names/descriptions and FN node names differ per locale. */
const DATA = {
  en_US: {
    moduleDesc1: "Fix Play Integrity attestation",
    moduleDesc2: "Spoof keybox on devices with broken TEE",
    moduleDesc3: "A Riru/Zygisk framework",
    fn1Name: "Network Guard",
    fn2Name: "Property Shield",
    log1: "Welcome to OnyxZygisk (v1.0)",
    log4: "Manual trigger of post-fs-data.sh",
  },
  zh_CN: {
    moduleDesc1: "修复 Play Integrity 认证",
    moduleDesc2: "在 TEE 损坏设备上伪造 keybox",
    moduleDesc3: "A Riru/Zygisk framework",
    fn1Name: "网络守卫",
    fn2Name: "属性护盾",
    log1: "欢迎使用 OnyxZygisk (v1.0)",
    log4: "手动触发 post-fs-data.sh",
  },
  ja_JP: {
    moduleDesc1: "Play Integrity 認証を修正",
    moduleDesc2: "TEE が壊れた端末で keybox を偽装",
    moduleDesc3: "Riru/Zygisk フレームワーク",
    fn1Name: "ネットワークガード",
    fn2Name: "プロパティシールド",
    log1: "OnyxZygisk へようこそ (v1.0)",
    log4: "post-fs-data.sh の手動実行",
  },
} as const;

export function devResponse(cmd: string): string {
  const d = DATA[currentLocale.value];
  if (cmd.indexOf("logcat") !== -1) {
    return [
      `I/zygiskd(1234): ${d.log1} `,
      "I/zygisk-core64(1256): zygisk library injected, version v1.0",
      "I/zygiskd(1234): Daemon listening on cp64.sock",
      `I/zygisk-sh(1201): ${d.log4}`,
    ].join("\n");
  }
  if (cmd.indexOf("@@fn") !== -1) {
    return [
      "status_protocol=1",
      "installed=1",
      "runtime=1",
      "version=1.0",
      "root=KernelSU",
      "z64=1",
      "z32=1",
      "daemon=1",
      "hotplug=1",
      "mount_mode=revert",
      "workdir=/data/adb/onyxzygisk",
      "@@monitor",
      "\tmonitor: \t tracing",
      "",
      "\tzygote64:\t injected",
      "\tdaemon64:\t running",
      "",
      "@@modules",
      `M|playintegrityfix|Play Integrity Fix|v18.8|chiteroman|1|0|${d.moduleDesc1} `,
      `M|tricky_store|Tricky Store|v1.2.1|5ec1cff|1|0|${d.moduleDesc2}`,
      `M|lsposed_mod|LSPosed (Mod)|v1.9.2|mywalkb|1|1|${d.moduleDesc3}`,
      "@@fn",
      `F|net_guard|${d.fn1Name}|1.0|app|com.bank.*|enabled`,
      `F|prop_shield|${d.fn2Name}|2.1|system_server|all|disabled`,
    ].join("\n");
  }
  return "";
}
