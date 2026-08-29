//! Ownership primitives for descriptors crossing the daemon boundary.

const std = @import("std");

pub const OwnedFd = struct {
    value: ?std.posix.fd_t = null,

    pub fn init(value: std.posix.fd_t) OwnedFd {
        return .{ .value = value };
    }

    pub fn invalid() OwnedFd {
        return .{};
    }

    pub fn isValid(self: *const OwnedFd) bool {
        return self.value != null;
    }

    pub fn get(self: *const OwnedFd) ?std.posix.fd_t {
        return self.value;
    }

    pub fn take(self: *OwnedFd) ?std.posix.fd_t {
        const value = self.value;
        self.value = null;
        return value;
    }

    pub fn close(self: *OwnedFd) void {
        if (self.take()) |value| std.posix.close(value);
    }

    pub fn deinit(self: *OwnedFd) void {
        self.close();
    }
};

test "invalid owned fd is inert" {
    var fd = OwnedFd.invalid();
    try std.testing.expect(!fd.isValid());
    try std.testing.expectEqual(@as(?std.posix.fd_t, null), fd.take());
}
