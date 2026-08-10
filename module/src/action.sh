#!/system/bin/sh
# ==============================================================================
# OnyxZygisk · Module action
#
# Presents the installed metadata and live monitor state as a compact status
# card. The monitor file intentionally contains both `key=value` metadata and
# tab-indented runtime rows, so it is formatted here instead of printed raw.
# ==============================================================================

MODDIR=${0%/*}
LIVE_PROP=@WORK_DIRECTORY@/module.prop
MODULE_PROP="$MODDIR/module.prop"

read_prop() {
  sed -n "s/^$1=//p" "$MODULE_PROP" 2>/dev/null | head -n 1
}

print_row() {
  printf '│  %-10s %s\n' "$1" "$2"
}

printf '\n╭─ 🧬 OnyxZygisk · Runtime Overview\n'
printf '├─ Module\n'
print_row "Name" "$(read_prop name)"
print_row "Version" "$(read_prop version)"
print_row "Module ID" "$(read_prop id)"
print_row "Authors" "$(read_prop author)"
printf '├─ Runtime\n'

if [ ! -f "$LIVE_PROP" ]; then
  print_row "Runtime" "status is not available yet"
else
  grep -Ev '^[[:blank:]]*[a-zA-Z][a-zA-Z0-9_]*=|^[[:blank:]]*=' "$LIVE_PROP" |
    sed -E 's/^[[:blank:]]+//; s/:[[:blank:]]+/: /' |
    while IFS= read -r row; do
      [ -n "$row" ] && printf '│  %s\n' "$row"
    done
fi

printf '├─ WebUI\n'
print_row "WebUI" "Open from your root manager or MMRL"
print_row "Path" "/data/adb/modules/onyxzygisk/webroot"
printf '╰─ No network port required\n\n'

if [ -z "$MMRL" ] && { [ -n "$KSU" ] || [ -n "$APATCH" ]; }; then
  # Keep the action window visible when the manager closes it immediately.
  sleep 5
fi
