#pragma once

#include <sys/ptrace.h>

#include <cstddef>
#include <cstdint>
#include <vector>

#include "utils.hpp"  // MapInfo, user_regs_struct, remote syscall primitives

// Maps `lib_path` into the tracee `pid` WITHOUT going through the system linker.
//
// It opens the file inside the target, reserves an anonymous region, mmaps each
// PT_LOAD segment, applies relocations and resolves the module's `entry` symbol
// -- all driven by raw remote syscalls (see remote_syscall/find_syscall_gadget).
//
// Because it never calls dlopen()/android_dlopen_ext(), the library never enters
// the linker's solist and -- the reason this exists -- is not subject to the
// bionic linker namespace allowlist that rejects a path-based dlopen on some
// KernelSU LKM late-load configurations ("library ... not found" despite the
// file being readable). This is the load path that makes injection work there.
//
// On success fills *out_base (mapping base), *out_total_size (reserved size) and
// *out_entry (absolute address of `entry`) and returns true. `regs` is used as
// scratch for the remote calls and is left restored to the caller's state.
//
// Adapted from PerformanC/ReZygisk (GPL-3.0), itself part of the CSOLoader
// project; conveyed here under AGPL-3.0 per GPL-3.0 §13. See NOTICE.md.
bool remote_csoloader_load_and_resolve_entry(int pid, struct user_regs_struct &regs,
                                             const std::vector<MapInfo> &remote_map,
                                             const std::vector<MapInfo> &local_map,
                                             const char *lib_path, uintptr_t *out_base,
                                             size_t *out_total_size, uintptr_t *out_entry);
