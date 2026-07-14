type HeartbeatSocket = {
  ping(): void;
  terminate(): void;
  on(event: 'pong', listener: () => void): unknown;
};

export function installWebSocketHeartbeat(
  socket: HeartbeatSocket,
  intervalMs = 25_000,
): () => void {
  let alive = true;
  socket.on('pong', () => {
    alive = true;
  });
  const interval = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, intervalMs);
  return () => clearInterval(interval);
}
