# Zig loader core

This directory contains platform-independent Zig primitives for the loader
rewrite. Zig is used here for small, deterministic native components; Rust
remains the implementation language for the daemon and transaction-heavy
logic. The Android Zygisk/JNI/linker ABI stays behind a narrow compatibility
boundary and is not reimplemented by these primitives.

The first slice is the bounded little-endian reader/writer in `src/ipc.zig`,
the monitor datagram decoder in `src/control.zig`, and the monitor lifecycle
state machine in `src/monitor.zig`.
It has no sockets, ptrace calls, or Android dependencies. The eventual Android
adapter should keep all system calls outside these primitives and pass only
validated byte slices and owned file descriptors across the boundary.

The source is not linked into the Android shared library yet. This is
intentional: the CI workflow pins Zig 0.14.1 and validates the core separately
before any ABI adapter is allowed into the zygote startup path.

Run locally with:

```sh
zig build test
```

The Android CMake project exposes the same check when Zig is installed:

```sh
cmake -DONYX_BUILD_ZIGCORE_TESTS=ON ...
cmake --build . --target zigcore-test
```
