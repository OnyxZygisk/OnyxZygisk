#!/system/bin/sh
# ==============================================================================
# OnyxZygisk · Uninstall cleanup
#
# Removes runtime state and persistent preferences after the module is deleted.
# ==============================================================================

export TMP_PATH=@WORK_DIRECTORY@

rm -rf "$TMP_PATH"
