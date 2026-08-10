#!/system/bin/sh
# ==============================================================================
# OnyxZygisk · KernelSU LKM late-load entry
#
# A late-loaded KernelSU appears after post-fs-data has already passed, so this
# entry invokes the shared bootstrap directly. Later lifecycle stages continue
# through KernelSU's normal service sequence.
# ==============================================================================

MODDIR=${0%/*}
cd "$MODDIR"

. "$MODDIR/zygisk-init.sh"
