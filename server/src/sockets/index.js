import { Server } from 'socket.io';
import cookie from 'cookie';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { verifyAccessToken, COOKIE_NAMES } from '../utils/tokens.js';

/**
 * Socket.IO server for real-time features. In Phase 1 it authenticates clients
 * from the access-token cookie and joins them to a private user room, enabling
 * presence and cross-device sync in later phases. AI streaming uses SSE (HTTP),
 * which is simpler and proxy-friendly for token streaming.
 */
export function initSockets(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: env.corsOrigins, credentials: true },
    path: '/socket.io',
  });

  io.use((socket, next) => {
    try {
      const cookies = cookie.parse(socket.handshake.headers.cookie || '');
      const token = cookies[COOKIE_NAMES.access];
      if (!token) return next(new Error('unauthorized'));
      const payload = verifyAccessToken(token);
      socket.userId = payload.sub;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.userId}`);
    logger.debug({ userId: socket.userId }, 'socket connected');
    socket.on('disconnect', () => logger.debug({ userId: socket.userId }, 'socket disconnected'));
  });

  return io;
}

export default initSockets;
