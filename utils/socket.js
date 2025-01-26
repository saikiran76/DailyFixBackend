import { Server } from 'socket.io';
import { logger } from './logger.js';

let io = null;

export function initializeSocketServer(server) {
  try {
    if (io) {
      logger.warn('[Socket] Socket.IO server already initialized');
      return io;
    }

    io = new Server(server, {
      cors: {
        origin: process.env.CLIENT_URL || 'http://localhost:3000',
        methods: ['GET', 'POST'],
        credentials: true
      },
      pingTimeout: 60000,
      pingInterval: 25000
    });

    io.on('connection', (socket) => {
      logger.info('[Socket] New connection established:', {
        socketId: socket.id,
        userId: socket.userId
      });

      socket.on('authenticate', (data) => {
        if (data.userId) {
          socket.userId = data.userId;
          socket.join(`user:${data.userId}`);
          logger.info('[Socket] User authenticated successfully:', {
            userId: data.userId,
            socketId: socket.id
          });
        }
      });

      socket.on('disconnect', () => {
        logger.info('[Socket] Client disconnected:', {
          socketId: socket.id,
          userId: socket.userId
        });
      });
    });

    logger.info('[Socket] Socket service initialized successfully');
    return io;
  } catch (error) {
    logger.error('[Socket] Failed to initialize Socket.IO server:', error);
    throw error;
  }
}

export function getIO() {
  if (!io) {
    logger.warn('[Socket] Socket.IO not initialized');
    return null;
  }
  return io;
}

export function emitToUser(userId, event, data) {
  if (!io) {
    logger.warn('[Socket] Socket.IO not initialized, cannot emit event:', event);
    return;
  }
  io.to(`user:${userId}`).emit(event, data);
}

export default {
  initializeSocketServer,
  getIO,
  emitToUser
}; 