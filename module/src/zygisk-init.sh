#!/system/bin/sh
# ==============================================================================
# OnyxZygisk · Shared runtime bootstrap
#
# Sourced by both normal post-fs-data startup and KernelSU LKM late-load.
# The caller must define MODDIR before entering this file.
# ==============================================================================

create_sys_perm() {
  mkdir -p "$1"
  chmod 555 "$1"
  chcon u:object_r:system_file:s0 "$1"
}

TMP_PATH=@WORK_DIRECTORY@

# ── Workspace ─────────────────────────────────────────────────────────────────
# Runtime sockets share this directory with persistent user preferences such
# as hot-plug flags and mount mode. Preserve the directory across reboots and
# remove only stale IPC endpoints from the previous session.
create_sys_perm "$TMP_PATH"
rm -f "$TMP_PATH"/*.sock "$TMP_PATH/init_monitor"

# ── Runtime libraries ─────────────────────────────────────────────────────────
if [ -f "$MODDIR/lib64/libzygisk.so" ]; then
  create_sys_perm "$TMP_PATH/lib64"
  cp "$MODDIR/lib64/libzygisk.so" "$TMP_PATH/lib64/libzygisk.so"
  chcon u:object_r:system_file:s0 "$TMP_PATH/lib64/libzygisk.so"
fi

if [ -f "$MODDIR/lib/libzygisk.so" ]; then
  create_sys_perm "$TMP_PATH/lib"
  cp "$MODDIR/lib/libzygisk.so" "$TMP_PATH/lib/libzygisk.so"
  chcon u:object_r:system_file:s0 "$TMP_PATH/lib/libzygisk.so"
fi

[ "$DEBUG" = true ] && export RUST_BACKTRACE=1

# ── Zygote monitor ────────────────────────────────────────────────────────────
if [ -f "$MODDIR/bin/zygisk-ptrace64" ]; then
  "$MODDIR/bin/zygisk-ptrace64" monitor &
elif [ -f "$MODDIR/bin/zygisk-ptrace32" ]; then
  "$MODDIR/bin/zygisk-ptrace32" monitor &
fi
