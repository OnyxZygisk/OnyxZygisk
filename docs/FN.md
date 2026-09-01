# FN (Functional Node) Modules

FN — **Functional Node** — is OnyxZygisk's own module format, layered on top of the
classic Zygisk module API. A classic Zygisk module is "a .so that gets injected";
a Functional Node is a **declarative, scoped, hot-swappable unit of functionality**
that the daemon understands, schedules, and reports on — and that the OnyxZygisk
manager app can present, toggle, and install without a reboot.

Design goals:

1. **Declarative** — every node carries a machine-readable descriptor (`fn.prop`),
   so the daemon and the manager app know *what it is, what it needs, and where it
   runs* before loading a single byte of native code.
2. **Scoped** — a node declares its trigger points and its target app set
   (allowlist/denylist), instead of being injected everywhere unconditionally.
3. **Hot-swappable** — enable/disable/remove take effect on the next process fork
   (or immediately for script-driven nodes), no reboot required.
4. **Observable** — every node reports a status the daemon surfaces over its IPC
   socket, so the UI can show *why* a node is inactive instead of guessing.

## On-disk layout

Nodes can be installed in either the original OnyxZygisk work directory or as
ordinary Magisk modules. A directory under `/data/adb/modules` is recognized as
an FN module only when it contains `fn.prop`, so existing Magisk modules are
not affected.

```
/data/adb/onyxzygisk/fn/<node-id>/
├── fn.prop            # required descriptor (key=value, same syntax as module.prop)
├── lib/
│   ├── arm64-v8a/fn.so   # optional native entry point (Zygisk API compatible)
│   └── armeabi-v7a/fn.so
├── service.sh         # optional, runs at late-start service like module scripts
├── post-fs-data.sh    # optional, runs at post-fs-data
├── disable            # state flag: node is disabled (touch to disable)
├── remove             # state flag: node is uninstalled on next daemon sweep
└── update             # state flag: pending update, replace on next sweep
```

```text
/data/adb/modules/<node-id>/
├── module.prop        # standard Magisk module metadata
├── fn.prop            # OnyxZygisk FN descriptor
├── service.sh         # optional FN boot script
├── post-fs-data.sh    # optional FN post-fs-data script
└── lib/<abi>/fn.so    # optional native FN entry library
```

Magisk's `disable`, `remove`, and `update` flags are honored for these modules.
Magisk owns `post-fs-data.sh` and `service.sh` for standard FN modules, while
OnyxZygisk owns those scripts for workdir nodes. This avoids running a Magisk
module's lifecycle script twice. Native entries from both formats are still
loaded by OnyxZygisk according to `trigger`, `scope`, and `apps`.

State flags follow the Magisk module convention so existing tooling intuition
carries over.

## `fn.prop` descriptor

| Key            | Required | Meaning |
|----------------|----------|---------|
| `id`           | yes | Unique node id, `[a-z0-9_\-]`, must match directory name |
| `name`         | yes | Human-readable name |
| `version`      | yes | Display version string |
| `versionCode`  | yes | Monotonic integer |
| `author`       | no  | Author |
| `description`  | no  | One-line description |
| `entry`        | no  | Native entry library path relative to node dir, e.g. `lib/arm64-v8a/fn.so`. Omit for script-only nodes |
| `trigger`      | no  | Comma list of trigger points: `post_fs_data`, `boot`, `zygote`, `system_server`, `app`. Default: `app` |
| `scope`        | no  | `all` (default), `allowlist`, or `denylist` |
| `apps`         | no  | Comma list of package names; with `allowlist` only these apps are targeted, with `denylist` these are excluded |
| `priority`     | no  | Integer, lower loads earlier. Default `100` |
| `capabilities` | no  | Comma list of declared capabilities: `inject`, `mount`, `fs`, `net`, `exec`. Informational in v1, enforced in later versions |
| `ui.summary`   | no  | Short marketing line for the manager app |

A node with neither `entry` nor any script is rejected at scan time with a
`Malformed` status.

## Daemon behavior (zygiskd)

- On startup and on demand, the daemon sweeps `fn/`:
  - nodes with a `remove` flag are deleted from disk and dropped;
  - `fn.prop` is parsed; invalid descriptors are kept in the list with a
    `Malformed` status so the UI can offer "remove broken node";
  - nodes with a `disable` flag are listed but never scheduled.
- Scan results are exposed over the daemon's Unix socket via new
  `DaemonSocketAction` variants (appended at the end of the enum to stay
  wire-compatible with older controllers):
  - `ListFnNodes` — returns the node list as a length-prefixed, line-based
    record stream (`key=value` lines, blank line between nodes, terminated by an
    empty record), mirroring how `ReadModules` frames its response;
  - `SetFnNodeEnabled` — payload `node-id` + `0|1`; creates/removes the
    `disable` flag;
  - `RemoveFnNode` — payload `node-id`; creates the `remove` flag and sweeps;
  - `ReadFnModules` — streams the **active native nodes** to the loader: for
    each node `id`, `triggers`, `scope` (0/1/2), `apps`, `priority` and the
    entry library as a sealed memfd, ordered by `priority` then `id`. This
    ordering defines the FN index space used by the two actions below
    (offset past the classic module count);
  - `GetFnModuleDir` — payload `node-id`; opens the node's directory, so
    `getModuleDir()` works for FN entry libraries too.
- **Script scheduling:** enabled nodes whose `trigger` includes `post_fs_data`
  get their `post-fs-data.sh` executed right after the daemon starts; nodes
  whose `trigger` includes `boot` get their `service.sh` executed when
  `SystemServerStarted` arrives (the late-start point where Magisk would run
  `service.sh`). Scripts run in the background with `MODDIR` set to the node
  directory; their stdout/stderr are fed into the daemon log so they show up
  in `logcat` and on the WebUI logs page.
- Node scheduling honors `trigger` and `priority`; app-scoped injection consults
  `scope`/`apps` at specialization time (loader side, phase 2).

## Loader behavior (phase 2, wired)

After classic Zygisk modules are loaded into a process, the loader requests the
active FN nodes via `ReadFnModules` and loads the entry libraries whose
`trigger` matches the process type:

| Process | Matching triggers |
|---|---|
| App process | `app`, `zygote` |
| system_server | `system_server`, `zygote` |

`zygote` means "at zygote level", i.e. every specialized process. For app
processes, `scope`/`apps` are then consulted against the specialize
`nice_name` (a `pkg:sub` process matches its `pkg` base name); system_server
is never scope-filtered. FN libraries use the same Zygisk API v4 companion
protocol as classic modules: they export `zygisk_module_entry`, and
`connectCompanion` / `getModuleDir` resolve to the FN node (companions are
keyed by node id, module dirs open `fn/<id>/`). The daemon sends the nodes
pre-sorted by `priority`, so the loader just appends them.

## Package format

An FN node is distributed as a zip with `fn.prop` at the root. Installation
happens through the daemon itself (the WebUI's `POST /api/fn/install`, or the
`install_fn_node` entry point): the descriptor is fully validated before any
file is touched, only whitelisted entries are extracted (`fn.prop`,
`service.sh`, `post-fs-data.sh`, `lib/…` — state flags and anything outside
the whitelist are rejected, and path traversal is impossible), scripts get
`0755`. If a node with the same `id` already exists its contents are replaced
in place — the `update` flag's hot-swap semantics applied immediately — and a
pre-existing `update` flag is consumed.

## Status model

Each scanned node carries one of: `Enabled`, `Disabled`, `PendingRemove`,
`PendingUpdate`, `Malformed(reason)`. The daemon computes status at scan time;
the UI never infers it from raw files.

## Example

A script-only node is two files:

```
fn/hello/            # zip root: fn.prop + service.sh
├── fn.prop          # id=hello\nname=Hello\nversion=1.0\nversionCode=1\ntrigger=boot\n
└── service.sh       # #!/system/bin/sh\necho hello > /data/local/tmp/hello.txt
```

See `docs/examples/` for ready-to-install workdir and Magisk package examples.
