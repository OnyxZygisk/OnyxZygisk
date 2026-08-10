#!/system/bin/sh
# Shared by post-fs-data.sh (normal boot) and late-load.sh (KernelSU LKM
# late-load mode, where post-fs-data.sh never runs — see that file). Caller
# must set MODDIR to the module directory before sourcing this.

create_sys_perm() {
  mkdir -p $1
  chmod 555 $1
  chcon u:object_r:system_file:s0 $1
}

TMP_PATH=@WORK_DIRECTORY@

# This work dir holds BOTH fresh-every-boot runtime state (IPC sockets, the
# copied libzygisk.so) and PERSISTENT user settings that must survive a reboot:
# the hot-plug opt-in flags (hotplug/<id>), the hot-plug master switch
# (hotplug_off), the mount mode (mount_mode) and the activation markers
# (hotplug_activated/). Keep the directory; only the stale runtime IPC from
# the previous boot is cleared.
create_sys_perm $TMP_PATH
rm -f "$TMP_PATH"/*.sock "$TMP_PATH/init_monitor"

if [ -f $MODDIR/lib64/libzygisk.so ];then
  create_sys_perm $TMP_PATH/lib64
  cp $MODDIR/lib64/libzygisk.so $TMP_PATH/lib64/libzygisk.so
  chcon u:object_r:system_file:s0 $TMP_PATH/lib64/libzygisk.so
fi

if [ -f $MODDIR/lib/libzygisk.so ];then
  create_sys_perm $TMP_PATH/lib
  cp $MODDIR/lib/libzygisk.so $TMP_PATH/lib/libzygisk.so
  chcon u:object_r:system_file:s0 $TMP_PATH/lib/libzygisk.so
fi

[ "$DEBUG" = true ] && export RUST_BACKTRACE=1

if [ -f $MODDIR/bin/zygisk-ptrace64 ];then
$MODDIR/bin/zygisk-ptrace64 monitor &
elif [ -f $MODDIR/bin/zygisk-ptrace32 ];then
$MODDIR/bin/zygisk-ptrace32 monitor &
fi
