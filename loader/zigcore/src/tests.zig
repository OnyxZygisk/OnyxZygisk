//! Aggregate test root for the platform-independent Zig loader core.

comptime {
    _ = @import("ipc.zig");
    _ = @import("fd.zig");
    _ = @import("monitor.zig");
    _ = @import("control.zig");
}
