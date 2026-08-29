/* OnyxZygisk — root manager bridge.
 *
 * KernelSU / APatch: ksu.exec(cmd, JSON.stringify(opts), cbName) → window[cb](errno, stdout, stderr)
 * MMRL: mmrl.exec(cmd) (promise or callback)
 * On a normal PC browser (no bridge) we return mocked data so the UI can be
 * developed/previewed — see ./mock.ts.
 *
 * All real output is base64-wrapped on the shell side and decoded as UTF-8
 * here to avoid the WebView bridge mangling Chinese / emoji (mojibake).
 */
import type { BridgeHost, ExecResult } from "../types";
import { devResponse } from "./mock";

export function detectBridge(): BridgeHost {
  if (window.ksu && typeof window.ksu.exec === "function") return "ksu";
  if (window.mmrl && typeof window.mmrl.exec === "function") return "mmrl";
  return null;
}

/** Low-level exec against the detected host bridge; never used directly. */
function bridgeRaw(cmd: string): Promise<ExecResult> {
  const host = detectBridge();
  if (host === "ksu") {
    return new Promise((resolve, reject) => {
      const name = "ksu_exec_" + Date.now() + "_" + Math.floor(Math.random() * 1e9);
      window[name] = (errno: number, stdout: string, stderr: string) => {
        delete window[name];
        resolve({ errno: errno || 0, stdout: stdout || "", stderr: stderr || "" });
      };
      try {
        window.ksu!.exec(cmd, "{}", name);
      } catch (e) {
        delete window[name];
        reject(e);
      }
    });
  }
  if (host === "mmrl") {
    try {
      const p = window.mmrl!.exec(cmd);
      if (p && typeof (p as Promise<MmrlExecResult>).then === "function") {
        return (p as Promise<MmrlExecResult>).then((r) => ({
          errno: r.code || 0,
          stdout: r.stdout || "",
          stderr: r.stderr || "",
        }));
      }
    } catch {
      /* fall through to callback style */
    }
    return new Promise((resolve) => {
      try {
        window.mmrl!.exec(cmd, (r) =>
          resolve({
            errno: r && r.code !== undefined ? r.code : 0,
            stdout: (r && r.stdout) || "",
            stderr: (r && r.stderr) || "",
          }),
        );
      } catch (e) {
        resolve({ errno: -1, stdout: "", stderr: String(e) });
      }
    });
  }
  return Promise.reject(new Error("no bridge"));
}

/** base64 → UTF-8 (atob gives a binary string; TextDecoder makes it real UTF-8). */
function b64ToUtf8(b64: string): string {
  const clean = String(b64).replace(/\s+/g, "");
  if (!clean) return "";
  try {
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return String(b64);
  }
}

/** Execute a shell command; stdout is guaranteed correct UTF-8. */
export async function exec(cmd: string): Promise<ExecResult> {
  if (!detectBridge()) return { errno: 0, stdout: devResponse(cmd), stderr: "" };
  // Preserve the wrapped command's exit status. Piping straight into `base64`
  // makes the pipeline report base64's (usually zero) status, which previously
  // turned every failed write/hot-plug command into a fake success.
  const wrapped = [
    'out="$({',
    cmd,
    '} 2>&1)"',
    "rc=$?",
    'printf "%s" "$out" | base64',
    'exit "$rc"',
  ].join("\n");
  const r = await bridgeRaw(wrapped);
  return { errno: r.errno, stdout: b64ToUtf8(r.stdout), stderr: r.stderr };
}

export function toast(msg: string): void {
  const host = detectBridge();
  try {
    if (host === "ksu") window.ksu!.toast(msg);
    else if (host === "mmrl" && window.mmrl!.toast) window.mmrl!.toast(msg);
    else console.log("[toast]", msg);
  } catch {
    console.log("[toast]", msg);
  }
}
