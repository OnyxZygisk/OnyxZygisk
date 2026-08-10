#!/system/bin/sh
# ==============================================================================
# OnyxZygisk · post-fs-data stage
#
# Starts the runtime and mirrors the lifecycle scripts of classic Zygisk
# modules when Magisk's built-in Zygisk is not driving them.
# ==============================================================================

MODDIR=${0%/*}
if [ "$ZYGISK_ENABLED" ]; then
  exit 0
fi

cd "$MODDIR"

if [ "$(which magisk)" ]; then
  for file in ../*; do
    if [ -d "$file" ] && [ -d "$file/zygisk" ] && ! [ -f "$file/disable" ]; then
      if [ -f "$file/post-fs-data.sh" ]; then
        cd "$file"
        log -p i -t "zygisk-sh" "Manually trigger post-fs-data.sh for $file"
        sh "$(realpath ./post-fs-data.sh)"
        cd "$MODDIR"
      fi
    fi
  done
fi

# Enter the shared bootstrap used by both normal and late-load startup.
. "$MODDIR/zygisk-init.sh"
