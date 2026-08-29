//! Platform-independent monitor state machine.
//!
//! Syscalls and ptrace status decoding stay in the platform adapter. This
//! module owns only legal state transitions, crash-loop accounting, and the
//! policy decision to stop tracing.

const std = @import("std");

pub const TracingState = enum { tracing, stopping, stopped, exiting };

pub const CrashPolicy = struct {
    window_seconds: i64 = 30,
    retry_count: u32 = 5,
};

pub const Monitor = struct {
    state: TracingState = .tracing,
    crash_count: u32 = 0,
    last_restart_seconds: ?i64 = null,
    policy: CrashPolicy = .{},
    stop_reason: ?[]const u8 = null,

    pub fn recordZygoteRestart(self: *Monitor, now_seconds: i64, was_running: bool) bool {
        if (!was_running) return false;
        if (self.last_restart_seconds) |last| {
            // Monotonic time is expected. Treat a clock anomaly as a new
            // observation instead of allowing a backwards jump to inflate a
            // crash counter indefinitely.
            if (now_seconds < last or now_seconds - last >= self.policy.window_seconds) {
                self.crash_count = 1;
            } else {
                self.crash_count = self.crash_count +| 1;
            }
        } else {
            self.crash_count = 1;
        }
        self.last_restart_seconds = now_seconds;
        return self.crash_count >= self.policy.retry_count;
    }

    pub fn notifyInjected(self: *Monitor) void {
        self.crash_count = 0;
        self.last_restart_seconds = null;
    }

    pub fn requestStop(self: *Monitor, reason: []const u8) void {
        if (self.state == .tracing) {
            self.state = .stopping;
            self.stop_reason = reason;
        }
    }

    pub fn notifyDetached(self: *Monitor) void {
        if (self.state == .stopping) self.state = .stopped;
    }

    pub fn requestStart(self: *Monitor) void {
        switch (self.state) {
            .stopping, .stopped => {
                self.state = .tracing;
                self.stop_reason = null;
            },
            else => {},
        }
    }

    pub fn requestExit(self: *Monitor) void {
        self.state = .exiting;
        self.stop_reason = "user requested";
    }
};

test "monitor counts only running zygote restarts" {
    var monitor = Monitor{ .policy = .{ .window_seconds = 30, .retry_count = 3 } };
    try std.testing.expect(!monitor.recordZygoteRestart(1, false));
    try std.testing.expect(!monitor.recordZygoteRestart(1, true));
    try std.testing.expect(!monitor.recordZygoteRestart(10, true));
    try std.testing.expect(monitor.recordZygoteRestart(20, true));
    try std.testing.expectEqual(@as(u32, 3), monitor.crash_count);
}

test "successful injection resets crash history" {
    var monitor = Monitor{ .policy = .{ .retry_count = 2 } };
    _ = monitor.recordZygoteRestart(1, true);
    monitor.notifyInjected();
    try std.testing.expectEqual(@as(u32, 0), monitor.crash_count);
    try std.testing.expect(!monitor.recordZygoteRestart(2, true));
}

test "backwards clock movement starts a fresh crash window" {
    var monitor = Monitor{ .policy = .{ .window_seconds = 30, .retry_count = 2 } };
    _ = monitor.recordZygoteRestart(100, true);
    try std.testing.expect(!monitor.recordZygoteRestart(90, true));
    try std.testing.expectEqual(@as(u32, 1), monitor.crash_count);
}

test "stop and exit transitions are deterministic" {
    var monitor = Monitor{};
    monitor.requestStop("daemon failed");
    try std.testing.expectEqual(TracingState.stopping, monitor.state);
    monitor.notifyDetached();
    try std.testing.expectEqual(TracingState.stopped, monitor.state);
    monitor.requestStart();
    try std.testing.expectEqual(TracingState.tracing, monitor.state);
    monitor.requestExit();
    try std.testing.expectEqual(TracingState.exiting, monitor.state);
}
