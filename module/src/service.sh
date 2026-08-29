#!/system/bin/sh
# ==============================================================================
# OnyxZygisk · late-start service stage
#
# Mirrors service.sh for classic Zygisk modules when their lifecycle is not
# already managed by Magisk's built-in Zygisk implementation.
# ==============================================================================

DEBUG=@DEBUG@

MODDIR=${0%/*}
if [ "$ZYGISK_ENABLED" ]; then
  exit 0
fi

# ── Boot-loop fail-safe: health witness ───────────────────────────────────────
# zygisk-init.sh increments a counter once per kernel boot.  Reset it as soon
# as Android reports boot completion.  The old unconditional 120-second delay
# falsely counted perfectly healthy boots when the user applied another
# hot-plug change shortly after reaching the launcher.
(
  waited=0
  while [ "$(getprop sys.boot_completed 2>/dev/null)" != "1" ] && [ "$waited" -lt 180 ]; do
    sleep 2
    waited=$((waited + 2))
  done
  if [ "$(getprop sys.boot_completed 2>/dev/null)" = "1" ]; then
    rm -f "@WORK_DIRECTORY@/boot_fail_count" \
      "@WORK_DIRECTORY@/boot_fail_boot_id"
    log -p i -t "zygisk-sh" "Boot health confirmed; consecutive-failure counter cleared"
  fi
) &

cd "$MODDIR"

if [ "$(which magisk)" ]; then
  for file in ../*; do
    if [ -d "$file" ] && [ -d "$file/zygisk" ] && ! [ -f "$file/disable" ]; then
      if [ -f "$file/service.sh" ]; then
        cd "$file"
        log -p i -t "zygisk-sh" "Manually trigger service.sh for $file"
        sh "$(realpath ./service.sh)" &
        cd "$MODDIR"
      fi
    fi
  done
fi
