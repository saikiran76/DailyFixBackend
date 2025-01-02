import { Server } from 'socket.io';
import { EventEmitter } from 'events';

export const ioEmitter = new EventEmitter();
let io;

export const initializeSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: 'http://localhost:5173',
      methods: ['GET', 'POST'],
    },
  });

  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
    });
  });

  // Listen for Discord events
  ioEmitter.on('discord_message', (data) => {
    io.emit('discord_message', data);
  });

  ioEmitter.on('discord_status', (data) => {
    io.emit('discord_status', data);
  });

  return io;
};

export const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized');
  }
  return io;
}; 