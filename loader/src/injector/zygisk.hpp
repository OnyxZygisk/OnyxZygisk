#pragma once

#include <jni.h>
#include <sys/types.h>

#include <string>

struct mount_info {
    unsigned int id;
    unsigned int parent;
    dev_t device;
    std::string root;
    std::string target;
    std::string vfs_options;
    std::string type;
    std::string source;
    std::string fs_options;
    std::string raw_info;
};

void hook_entry(void *start_addr, size_t block_size, bool custom_loaded);

void hookJniNativeMethods(JNIEnv *env, const char *clz, JNINativeMethod *methods, int numMethods);

void clean_libc_trace();

void clean_linker_trace(const char *path, size_t loaded_modules, size_t unloaded_modules,
                        bool unload_soinfo);

void spoof_virtual_maps(const char *path, bool clear_write_permission);

void spoof_zygote_fossil(char *search_from, char *search_to, const char *anchor);

/// Rewrite the `TracerPid:` line in a buffer read from /proc/<pid>/status
/// so detection software cannot observe a non-zero tracer PID after the
/// injector has detached.  Returns the number of bytes the caller should
/// report as read (the rewrite is in-place and never grows the buffer).
size_t sanitize_tracer_pid_in_buffer(char *buf, size_t nbytes);

/// Strip the pathname from any `/proc/<pid>/maps` line whose backing file
/// looks like a Zygisk artefact (`jit-cache-zygisk`, `memfd:...`,
/// `zygisk-module`, ...).  The line is kept (so the row count and address
/// layout stay identical) but its trailing pathname is blanked, so the
/// mapping looks anonymous to detection software.  Returns the (possibly
/// shortened) byte count the caller should report as read.
size_t sanitize_maps_in_buffer(char *buf, size_t nbytes);

void send_seccomp_event_if_needed();

std::vector<mount_info> check_zygote_traces(uint32_t info_flags);
