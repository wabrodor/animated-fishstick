import jwt from 'jsonwebtoken';
import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { env, allowedOrigins } from './config.js';
import { Organization, User } from './models.js';

const JWT_ISSUER = 'apexcare-api';
const JWT_AUDIENCE = 'apexcare-client';

let io: Server | null = null;

export function createSocketServer(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: allowedOrigins, methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
  });

  io.use(async (socket, next) => {
    try {
      const token = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : '';
      if (!token) return next(new Error('AUTH_REQUIRED'));
      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
        algorithms: ['HS256'], issuer: JWT_ISSUER, audience: JWT_AUDIENCE,
      });
      if (typeof payload === 'string' || typeof payload.userId !== 'string' || typeof payload.organizationId !== 'string') {
        return next(new Error('AUTH_INVALID'));
      }
      const user = await User.findOne({ _id: payload.userId, organizationId: payload.organizationId, status: 'ACTIVE' }).select('_id organizationId roles status').lean();
      const organization = user ? await Organization.findOne({ _id: user.organizationId, status: 'ACTIVE' }).select('_id type').lean() : null;
      if (!user || !organization) return next(new Error('AUTH_INVALID'));
      socket.data.auth = { userId: String(user._id), organizationId: String(user.organizationId), organizationType: organization.type, roles: user.roles };
      next();
    } catch {
      next(new Error('AUTH_INVALID'));
    }
  });

  io.on('connection', (socket) => {
    const auth = socket.data.auth as { userId: string; organizationId: string };
    socket.join(`user:${auth.userId}`);
    socket.join(`organization:${auth.organizationId}`);
    socket.emit('notifications:connected', { connectedAt: new Date().toISOString() });
  });

  return io;
}

export function emitNotification(userId: string, notification: Record<string, unknown>): void {
  io?.to(`user:${userId}`).emit('notification:new', notification);
}

export function emitNotificationRead(userId: string, notificationId: string): void {
  io?.to(`user:${userId}`).emit('notification:read', { notificationId });
}

export function emitAllNotificationsRead(userId: string): void {
  io?.to(`user:${userId}`).emit('notification:all-read', { readAt: new Date().toISOString() });
}
