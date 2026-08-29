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
#
# hotplug_restart_guard is deliberately NOT deleted here: it is the hot-plug
# circuit breaker's crash evidence. If the previous session ended while a
# restart was armed/observed, the daemon unplugs the named module at startup
# (see resolve_stale_restart_guard). Deleting the file here would destroy
# that evidence and let a system_server-crashing module loop every boot.
create_sys_perm "$TMP_PATH"
rm -f "$TMP_PATH"/*.sock "$TMP_PATH/init_monitor" \
  "$TMP_PATH"/hotplug_activated/*.applying

# ── Boot-loop fail-safe ───────────────────────────────────────────────────────
# Count consecutive kernel boots that never proved healthy. service.sh clears
# the counter as soon as Android reports boot completion; reaching the threshold
# means our injection itself is implicated in a boot loop, so latch the kill
# switch and let the monitor skip all ptrace/injection for the coming boots
# until the user clears the flag.
FAIL_COUNT_FILE="$TMP_PATH/boot_fail_count"
FAIL_BOOT_FILE="$TMP_PATH/boot_fail_boot_id"
FAILSAFE_FLAG="$TMP_PATH/injection_disabled"
fail_count=0
[ -f "$FAIL_COUNT_FILE" ] && fail_count=$(cat "$FAIL_COUNT_FILE" 2>/dev/null)
case "$fail_count" in ''|*[!0-9]*) fail_count=0 ;; esac
boot_id=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)
counted_boot=$(cat "$FAIL_BOOT_FILE" 2>/dev/null)
if [ -z "$boot_id" ] || [ "$counted_boot" != "$boot_id" ]; then
  fail_count=$((fail_count + 1))
  echo "$fail_count" > "$FAIL_COUNT_FILE"
  [ -n "$boot_id" ] && echo "$boot_id" > "$FAIL_BOOT_FILE"
fi
if [ "$fail_count" -ge 3 ] && [ ! -f "$FAILSAFE_FLAG" ]; then
  touch "$FAILSAFE_FLAG"
  log -p e -t "zygisk-sh" "Boot-loop fail-safe: $fail_count consecutive unhealthy boots; injection latched OFF until $FAILSAFE_FLAG is removed"
fi

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
