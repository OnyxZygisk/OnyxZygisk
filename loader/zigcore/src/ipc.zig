//! Small, bounded primitives shared by the future Zig loader layers.
//!
//! The current daemon protocol is a stream of typed fields rather than a
//! length-delimited message. These primitives deliberately do not reinterpret
//! that protocol or perform I/O. They provide bounded decoding and canonical
//! little-endian encoding so socket code can be tested without Android.

const std = @import("std");
comptime {
    _ = @import("fd.zig");
    _ = @import("monitor.zig");
    _ = @import("control.zig");
}

pub const Error = error{
    UnexpectedEnd,
    InvalidLength,
    LengthOverflow,
    OutOfMemory,
};

pub const max_string_bytes: usize = 1024 * 1024;

/// Wire values from zygiskd/src/constants.rs. New values may only be appended.
pub const DaemonSocketAction = enum(u8) {
    ping_heartbeat = 0,
    get_process_flags = 1,
    cache_mount_namespace = 2,
    update_mount_namespace = 3,
    read_modules = 4,
    request_companion_socket = 5,
    get_module_dir = 6,
    zygote_restart = 7,
    system_server_started = 8,
    list_fn_nodes = 9,
    set_fn_node_enabled = 10,
    remove_fn_node = 11,
    read_fn_modules = 12,
    get_fn_module_dir = 13,

    pub fn fromByte(value: u8) Error!DaemonSocketAction {
        return std.meta.intToEnum(DaemonSocketAction, value) catch error.InvalidLength;
    }
};

pub const FnModule = struct {
    id: []const u8,
    triggers: []const u8,
    scope: u8,
    apps: []const u8,
    priority: u32,
};

pub const Reader = struct {
    bytes: []const u8,
    offset: usize = 0,

    pub fn init(bytes: []const u8) Reader {
        return .{ .bytes = bytes };
    }

    pub fn remaining(self: *const Reader) usize {
        return self.bytes.len - self.offset;
    }

    fn take(self: *Reader, length: usize) Error![]const u8 {
        if (length > self.remaining()) return error.UnexpectedEnd;
        const result = self.bytes[self.offset .. self.offset + length];
        self.offset += length;
        return result;
    }

    pub fn readU8(self: *Reader) Error!u8 {
        return (try self.take(1))[0];
    }

    pub fn readU32(self: *Reader) Error!u32 {
        const bytes = try self.take(4);
        return @as(u32, bytes[0]) |
            (@as(u32, bytes[1]) << 8) |
            (@as(u32, bytes[2]) << 16) |
            (@as(u32, bytes[3]) << 24);
    }

    pub fn readUSize(self: *Reader) Error!usize {
        if (@sizeOf(usize) == 4) return @as(usize, try self.readU32());
        return @as(usize, try self.readU64());
    }

    fn readU64(self: *Reader) Error!u64 {
        const bytes = try self.take(8);
        var value: u64 = 0;
        for (bytes, 0..) |byte, index| value |= @as(u64, byte) << @intCast(index * 8);
        return value;
    }

    /// Reads the daemon's length-prefixed string and validates its bound.
    pub fn readString(self: *Reader) Error![]const u8 {
        const length = try self.readUSize();
        if (length > max_string_bytes) return error.InvalidLength;
        return self.take(length);
    }

    /// Reads one ReadFnModules metadata record. The FD itself is transported
    /// out-of-band by SCM_RIGHTS and is intentionally not represented here.
    pub fn readFnModule(self: *Reader) Error!FnModule {
        const id = try self.readString();
        const triggers = try self.readString();
        const scope = try self.readU8();
        if (scope > 2) return error.InvalidLength;
        const apps = try self.readString();
        const priority = try self.readU32();
        return .{
            .id = id,
            .triggers = triggers,
            .scope = scope,
            .apps = apps,
            .priority = priority,
        };
    }
};

pub const Writer = struct {
    list: std.ArrayList(u8),

    pub fn init(allocator: std.mem.Allocator) Writer {
        return .{ .list = std.ArrayList(u8).init(allocator) };
    }

    pub fn deinit(self: *Writer) void {
        self.list.deinit();
    }

    pub fn bytes(self: *const Writer) []const u8 {
        return self.list.items;
    }

    pub fn writeU8(self: *Writer, value: u8) !void {
        try self.list.append(value);
    }

    pub fn writeU32(self: *Writer, value: u32) !void {
        var encoded: [@sizeOf(u32)]u8 = undefined;
        std.mem.writeInt(u32, &encoded, value, .little);
        try self.list.appendSlice(&encoded);
    }

    pub fn writeUSize(self: *Writer, value: usize) Error!void {
        if (@sizeOf(usize) == 4) {
            if (value > std.math.maxInt(u32)) return error.LengthOverflow;
            try self.writeU32(@intCast(value));
        } else {
            var encoded: [@sizeOf(u64)]u8 = undefined;
            std.mem.writeInt(u64, &encoded, @intCast(value), .little);
            try self.list.appendSlice(&encoded);
        }
    }

    pub fn writeString(self: *Writer, value: []const u8) Error!void {
        if (value.len > max_string_bytes) return error.InvalidLength;
        try self.writeUSize(value.len);
        try self.list.appendSlice(value);
    }
};

test "reader decodes bounded little endian fields" {
    var writer = Writer.init(std.testing.allocator);
    defer writer.deinit();

    try writer.writeU8(7);
    try writer.writeU32(0x12345678);
    try writer.writeString("zygisk");

    var reader = Reader.init(writer.bytes());
    try std.testing.expectEqual(@as(u8, 7), try reader.readU8());
    try std.testing.expectEqual(@as(u32, 0x12345678), try reader.readU32());
    try std.testing.expectEqualStrings("zygisk", try reader.readString());
    try std.testing.expectEqual(@as(usize, 0), reader.remaining());
}

test "reader rejects truncated fields" {
    var reader = Reader.init(&[_]u8{ 1, 2, 3 });
    try std.testing.expectError(error.UnexpectedEnd, reader.readU32());
}

test "reader rejects oversized strings before slicing" {
    var bytes: [@sizeOf(usize)]u8 = undefined;
    std.mem.writeInt(usize, &bytes, max_string_bytes + 1, .little);
    var reader = Reader.init(&bytes);
    try std.testing.expectError(error.InvalidLength, reader.readString());
}

test "writer rejects oversized strings" {
    var writer = Writer.init(std.testing.allocator);
    defer writer.deinit();
    const value = try std.testing.allocator.alloc(u8, max_string_bytes + 1);
    defer std.testing.allocator.free(value);
    try std.testing.expectError(error.InvalidLength, writer.writeString(value));
}

test "reader preserves trailing fields for the next layer" {
    var writer = Writer.init(std.testing.allocator);
    defer writer.deinit();
    try writer.writeU8(12);
    try writer.writeU8(34);

    var reader = Reader.init(writer.bytes());
    try std.testing.expectEqual(@as(u8, 12), try reader.readU8());
    try std.testing.expectEqual(@as(usize, 1), reader.remaining());
    try std.testing.expectEqual(@as(u8, 34), try reader.readU8());
}

test "daemon action values remain wire compatible" {
    try std.testing.expectEqual(DaemonSocketAction.ping_heartbeat, try DaemonSocketAction.fromByte(0));
    try std.testing.expectEqual(DaemonSocketAction.read_fn_modules, try DaemonSocketAction.fromByte(12));
    try std.testing.expectError(error.InvalidLength, DaemonSocketAction.fromByte(14));
}

test "reader decodes FN metadata and rejects invalid scope" {
    var writer = Writer.init(std.testing.allocator);
    defer writer.deinit();
    try writer.writeString("example");
    try writer.writeString("app,zygote");
    try writer.writeU8(1);
    try writer.writeString("com.example");
    try writer.writeU32(42);

    var reader = Reader.init(writer.bytes());
    const module = try reader.readFnModule();
    try std.testing.expectEqualStrings("example", module.id);
    try std.testing.expectEqualStrings("app,zygote", module.triggers);
    try std.testing.expectEqual(@as(u8, 1), module.scope);
    try std.testing.expectEqualStrings("com.example", module.apps);
    try std.testing.expectEqual(@as(u32, 42), module.priority);
    try std.testing.expectEqual(@as(usize, 0), reader.remaining());

    var invalid = Writer.init(std.testing.allocator);
    defer invalid.deinit();
    try invalid.writeString("bad");
    try invalid.writeString("app");
    try invalid.writeU8(3);
    var invalid_reader = Reader.init(invalid.bytes());
    try std.testing.expectError(error.InvalidLength, invalid_reader.readFnModule());
}
