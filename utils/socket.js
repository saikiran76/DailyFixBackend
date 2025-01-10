import { EventEmitter } from 'events';

export const ioEmitter = new EventEmitter();
let io;

export const initializeSocket = (server) => {
  if (io) {
    console.warn('Socket.IO already initialized, returning existing instance');
    return io;
  }

  // Socket initialization should be done through socketService.js
  throw new Error('Socket initialization should be done through socketService.js');
};

export const getIO = () => {
  if (!io) {
    throw new Error('Socket.IO not initialized. Call initializeSocketServer from socketService.js first.');
  }
  return io;
};

export const setIO = (socketInstance) => {
  if (io) {
    console.warn('Overwriting existing Socket.IO instance');
  }
  io = socketInstance;
}; 