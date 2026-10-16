/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** x86_64 classic BPF, inherited from the outer namespace into the native filesystem sandbox.
 * Only IP socket creation is permitted. Anonymous socketpair IPC remains available;
 * pathname/abstract Unix socket connections cannot be created. No host network route exists.
 */
export function isolatedProjectSocketFilter(): Buffer {
  const instructions: readonly [number, number, number, number][] = [
    [0x20, 0, 0, 4], // seccomp_data.arch
    [0x15, 1, 0, 0xc000003e], // AUDIT_ARCH_X86_64
    [0x06, 0, 0, 0x80000000], // kill process on unsupported ABI
    [0x20, 0, 0, 0], // syscall number
    [0x35, 0, 1, 0x40000000], // reject x32 syscall ABI
    [0x06, 0, 0, 0x80000000],
    ...[101, 310, 311, 425, 426, 427, 321, 298].flatMap(
      (syscall): [number, number, number, number][] => [
        [0x15, 0, 1, syscall],
        [0x06, 0, 0, 0x00050001], // EPERM
      ],
    ),
    [0x15, 0, 6, 53], // socketpair: only already-connected connection-oriented IPC
    [0x20, 0, 0, 24], // type
    [0x54, 0, 0, 0xf], // remove CLOEXEC/NONBLOCK flags
    [0x15, 2, 0, 1], // SOCK_STREAM
    [0x15, 1, 0, 5], // SOCK_SEQPACKET: native bwrap PID/privilege synchronization
    [0x06, 0, 0, 0x00050001],
    [0x06, 0, 0, 0x7fff0000],
    [0x15, 0, 4, 41], // socket
    [0x20, 0, 0, 16], // socket domain
    [0x15, 2, 0, 2], // AF_INET
    [0x15, 1, 0, 10], // AF_INET6
    [0x06, 0, 0, 0x00050001],
    [0x06, 0, 0, 0x7fff0000], // allow
  ];
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, yes, no, value], index) => {
    bytes.writeUInt16LE(code, index * 8);
    bytes[index * 8 + 2] = yes;
    bytes[index * 8 + 3] = no;
    bytes.writeUInt32LE(value, index * 8 + 4);
  });
  return bytes;
}
