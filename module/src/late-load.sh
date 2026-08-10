#!/system/bin/sh
# KernelSU LKM late-load mode: this runs INSTEAD of post-fs-data.sh, because
# by the time a late-loaded KernelSU exists, the real post-fs-data boot stage
# has already passed without it. service.sh and boot-completed.sh still fire
# normally afterwards through KSU's regular stage sequence.

MODDIR=${0%/*}
cd "$MODDIR"

. "$MODDIR/zygisk-init.sh"
