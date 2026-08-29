//! Decoder for the monitor's Unix datagram control protocol.
//!
//! The platform adapter supplies one complete datagram. Keeping decoding here
//! means malformed packets are rejected before they can affect ptrace state.

const std = @import("std");

pub const Error = error{UnexpectedEnd, InvalidCommand, InvalidLength};
pub const max_payload_bytes: usize = 64 * 1024;

pub const Command = enum(u32) {
    start = 1,
    stop = 2,
    exit = 3,
    zygote_injected = 4,
    daemon_set_info = 5,
    daemon_set_error_info = 6,
    system_server_started = 7,
};

pub const Packet = struct {
    command: Command,
    payload: []const u8,
};

/// Decode the monitor's native-layout command packet. `Command` is a C++
/// unscoped enum and therefore occupies four bytes on the Android ABIs used
/// by this project; status packets append a four-byte signed length.
pub fn decode(bytes: []const u8) Error!Packet {
    if (bytes.len < @sizeOf(u32)) return error.UnexpectedEnd;
    const command_value = std.mem.readInt(u32, bytes[0..4], .little);
    const command = std.meta.intToEnum(Command, command_value) catch return error.InvalidCommand;

    const has_payload = command == .daemon_set_info or command == .daemon_set_error_info;
    if (!has_payload) {
        if (bytes.len != @sizeOf(u32)) return error.InvalidLength;
        return .{ .command = command, .payload = bytes[4..] };
    }

    if (bytes.len < 8) return error.UnexpectedEnd;
    const length_bits = @as(u32, bytes[4]) |
        (@as(u32, bytes[5]) << 8) |
        (@as(u32, bytes[6]) << 16) |
        (@as(u32, bytes[7]) << 24);
    const length: i32 = @bitCast(length_bits);
    if (length < 0 or @as(usize, @intCast(length)) > max_payload_bytes) {
        return error.InvalidLength;
    }
    const payload_length: usize = @intCast(length);
    if (bytes.len != 8 + payload_length) return error.InvalidLength;
    return .{ .command = command, .payload = bytes[8..] };
}

test "control decoder accepts short command" {
    const bytes = [_]u8{ 1, 0, 0, 0 };
    const packet = try decode(&bytes);
    try std.testing.expectEqual(Command.start, packet.command);
    try std.testing.expectEqual(@as(usize, 0), packet.payload.len);
}

test "control decoder accepts bounded status payload" {
    const bytes = [_]u8{ @intFromEnum(Command.daemon_set_info), 0, 0, 0, 3, 0, 0, 0, 'o', 'k', 0 };
    const packet = try decode(&bytes);
    try std.testing.expectEqualStrings("ok\x00", packet.payload);
}

test "control decoder rejects malformed packets" {
    try std.testing.expectError(error.InvalidCommand, decode(&[_]u8{ 99, 0, 0, 0 }));
    try std.testing.expectError(error.InvalidLength, decode(&[_]u8{ 1, 0, 0, 0, 0 }));
    try std.testing.expectError(error.InvalidLength, decode(&[_]u8{ 5, 0, 0, 0, 255, 255, 255, 127 }));
}
