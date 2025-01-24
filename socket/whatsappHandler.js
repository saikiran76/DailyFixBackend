import { matrixWhatsAppService } from '../services/matrixWhatsAppService.js';
import { logger } from '../utils/logger.js';
import { adminClient } from '../utils/supabase.js';
import { tokenService } from '../services/tokenService.js';

const SETUP_TIMEOUT = 300000; // 5 minutes

class WhatsAppSocketHandler {
  constructor(io) {
    this.io = io;
    this.connections = new Map();
    this.retryConfig = {
      maxAttempts: 5,
      initialDelay: 1000,
      maxDelay: 30000,
      factor: 2
    };

    this.eventHandlers = new Map();
    this.pendingOperations = new Map();
    this.healthChecks = new Map();

    // Initialize event handlers
    this.setupEventHandlers();
    
    // Start health checks
    this.startHealthChecks();
  }

  setupEventHandlers() {
    // Core events
    this.registerHandler('whatsapp:connect', this.handleConnect.bind(this));
    this.registerHandler('whatsapp:disconnect', this.handleDisconnect.bind(this));
    this.registerHandler('whatsapp:message', this.handleMessage.bind(this));
    this.registerHandler('whatsapp:sync', this.handleSync.bind(this));
    
    // Status events
    this.registerHandler('whatsapp:status', this.handleStatus.bind(this));
    this.registerHandler('whatsapp:typing', this.handleTyping.bind(this));
    
    // Error events
    this.registerHandler('whatsapp:error', this.handleError.bind(this));
  }

  registerHandler(event, handler) {
    this.eventHandlers.set(event, async (...args) => {
      try {
        await handler(...args);
      } catch (error) {
        logger.error('[WhatsApp Socket] Event handler error:', {
          event,
          error: error.message
        });
        this.handleError(args[0], error);
      }
    });
  }

  startHealthChecks() {
    setInterval(() => this.checkConnections(), 30000);
  }

  async checkConnections() {
    for (const [socketId, connection] of this.connections.entries()) {
      try {
        const isHealthy = await this.checkConnectionHealth(socketId, connection);
        if (!isHealthy) {
          await this.handleUnhealthyConnection(socketId, connection);
        }
      } catch (error) {
        logger.error('[WhatsApp Socket] Health check failed:', {
          socketId,
          error: error.message
        });
      }
    }
  }

  async checkConnectionHealth(socketId, connection) {
    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket?.connected) {
      return false;
    }

    try {
      await this.sendWithTimeout(socket, 'whatsapp:ping', {}, 5000);
      return true;
    } catch (error) {
      return false;
    }
  }

  async handleUnhealthyConnection(socketId, connection) {
    logger.warn('[WhatsApp Socket] Unhealthy connection detected:', { socketId });
    
    try {
      await this.reconnect(socketId, connection);
    } catch (error) {
      logger.error('[WhatsApp Socket] Reconnection failed:', {
        socketId,
        error: error.message
      });
      this.connections.delete(socketId);
    }
  }

  async reconnect(socketId, connection) {
    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      throw new Error('Socket not found');
    }

    // Attempt reconnection with exponential backoff
    let attempt = 0;
    let delay = this.retryConfig.initialDelay;

    while (attempt < this.retryConfig.maxAttempts) {
      try {
        await this.executeWithRetry(
          () => this.handleConnect(socket, connection.userId),
          attempt
        );
        return;
      } catch (error) {
        attempt++;
        if (attempt < this.retryConfig.maxAttempts) {
          await this.delay(delay);
          delay = Math.min(
            delay * this.retryConfig.factor,
            this.retryConfig.maxDelay
          );
        }
      }
    }

    throw new Error('Max reconnection attempts exceeded');
  }

  async executeWithRetry(operation, attempt) {
    try {
      return await operation();
    } catch (error) {
      if (attempt < this.retryConfig.maxAttempts - 1) {
        throw error;
      }
      
      // Log final attempt failure
      logger.error('[WhatsApp Socket] Operation failed:', {
        attempt,
        error: error.message
      });
      throw error;
    }
  }

  async sendWithTimeout(socket, event, data, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Operation timed out'));
      }, timeout);

      socket.emit(event, data, (response) => {
        clearTimeout(timer);
        if (response?.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  }

  async handleConnect(socket, userId) {
    try {
      // Validate connection request
      if (!userId) {
        throw new Error('User ID required');
      }

      // Setup connection tracking
      this.connections.set(socket.id, {
        userId,
        connectedAt: Date.now(),
        lastActivity: Date.now()
      });

      // Setup socket event listeners
      for (const [event, handler] of this.eventHandlers.entries()) {
        socket.on(event, (...args) => {
          this.handleEvent(socket, event, handler, args);
        });
      }

      // Notify client of successful connection
      socket.emit('whatsapp:connected', {
        socketId: socket.id,
        timestamp: Date.now()
      });

      logger.info('[WhatsApp Socket] Client connected:', {
        socketId: socket.id,
        userId
      });
    } catch (error) {
      logger.error('[WhatsApp Socket] Connection failed:', {
        socketId: socket.id,
        userId,
        error: error.message
      });
      socket.emit('whatsapp:error', {
        code: 'CONNECTION_FAILED',
        message: error.message
      });
    }
  }

  async handleEvent(socket, event, handler, args) {
    const operationId = `${socket.id}:${event}:${Date.now()}`;
    
    try {
      // Track operation start
      this.pendingOperations.set(operationId, {
        event,
        startedAt: Date.now()
      });

      // Update last activity
      const connection = this.connections.get(socket.id);
      if (connection) {
        connection.lastActivity = Date.now();
      }

      // Execute handler with retry if needed
      await this.executeWithRetry(() => handler(socket, ...args), 0);

    } catch (error) {
      logger.error('[WhatsApp Socket] Event handling failed:', {
        socketId: socket.id,
        event,
        error: error.message
      });
      
      socket.emit('whatsapp:error', {
        code: 'EVENT_HANDLING_FAILED',
        message: error.message,
        event
      });
    } finally {
      this.pendingOperations.delete(operationId);
    }
  }

  async handleDisconnect(socket) {
    try {
      const connection = this.connections.get(socket.id);
      if (connection) {
        // Cleanup resources
        this.connections.delete(socket.id);
        
        logger.info('[WhatsApp Socket] Client disconnected:', {
          socketId: socket.id,
          userId: connection.userId
        });
      }
    } catch (error) {
      logger.error('[WhatsApp Socket] Disconnect handling failed:', {
        socketId: socket.id,
        error: error.message
      });
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async handleMessage(socket, data) {
    try {
      const { userId } = this.connections.get(socket.id);
      const { contactId, message } = data;

      if (!contactId || !message) {
        throw new Error('Invalid message data');
      }

      await matrixWhatsAppService.sendMessage(userId, contactId, message);
      
      socket.emit('whatsapp:message:sent', {
        contactId,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('[WhatsApp Socket] Message handling failed:', error);
      socket.emit('whatsapp:error', {
        code: 'MESSAGE_FAILED',
        message: error.message
      });
    }
  }

  async handleSync(socket, data) {
    try {
      const { userId } = this.connections.get(socket.id);
      const { contactId } = data;

      if (!contactId) {
        throw new Error('Contact ID required');
      }

      await matrixWhatsAppService.syncMessages(userId, contactId);
      
      socket.emit('whatsapp:sync:complete', {
        contactId,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('[WhatsApp Socket] Sync failed:', error);
      socket.emit('whatsapp:error', {
        code: 'SYNC_FAILED',
        message: error.message
      });
    }
  }

  async handleStatus(socket) {
    try {
      const { userId } = this.connections.get(socket.id);
      const status = await matrixWhatsAppService.getStatus(userId);
      
      socket.emit('whatsapp:status', status);
    } catch (error) {
      logger.error('[WhatsApp Socket] Status check failed:', error);
      socket.emit('whatsapp:error', {
        code: 'STATUS_FAILED',
        message: error.message
      });
    }
  }

  async handleTyping(socket, data) {
    try {
      const { userId } = this.connections.get(socket.id);
      const { contactId, isTyping } = data;

      if (!contactId) {
        throw new Error('Contact ID required');
      }

      await matrixWhatsAppService.setTyping(userId, contactId, isTyping);
      
      socket.emit('whatsapp:typing:sent', {
        contactId,
        isTyping,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('[WhatsApp Socket] Typing status failed:', error);
      socket.emit('whatsapp:error', {
        code: 'TYPING_FAILED',
        message: error.message
      });
    }
  }

  handleError(socket, error) {
    logger.error('[WhatsApp Socket] Error:', error);
    socket.emit('whatsapp:error', {
      code: error.code || 'UNKNOWN_ERROR',
      message: error.message
    });
  }
}

export const whatsAppHandler = new WhatsAppSocketHandler();

export const setupWhatsAppHandlers = (io, socket) => {
  const userId = socket.auth?.userId;
  if (!userId) {
    logger.error('[WhatsApp Socket] No userId in socket auth');
    return;
  }

  let setupTimeout;

  // Handle WhatsApp setup initiation
  socket.on('whatsapp:setup:start', async (data) => {
    try {
      logger.info('[WhatsApp Socket] Setup started for user:', data.userId);
      
      // Emit preparing state
      socket.emit('whatsapp:setup:status', {
        state: 'preparing',
        timestamp: new Date().toISOString()
      });

      // Initialize Matrix client if needed
      const client = await matrixWhatsAppService.getMatrixClient(userId);
      if (!client) {
        throw new Error('Matrix client initialization failed');
      }

      // Start bridge setup
      const bridgeRoom = await matrixWhatsAppService.connectWhatsApp(userId);
      
      // Set timeout for setup
      setupTimeout = setTimeout(() => {
        socket.emit('whatsapp:setup:status', {
          state: 'error',
          error: {
            message: 'Setup timed out',
            type: 'TIMEOUT_ERROR'
          }
        });
      }, SETUP_TIMEOUT);

      // Listen for QR code events from Matrix
      client.on('Room.timeline', (event) => {
        if (event.getType() === 'm.room.message' && 
            event.getContent().msgtype === 'm.image' &&
            event.getContent().body?.includes('QR code')) {
          
          socket.emit('whatsapp:qr', {
            qrCode: event.getContent().url,
            timestamp: new Date().toISOString()
          });

          socket.emit('whatsapp:setup:status', {
            state: 'scanning',
            timestamp: new Date().toISOString()
          });
        }
      });

    } catch (error) {
      logger.error('[WhatsApp Socket] Setup error:', error);
      socket.emit('whatsapp:setup:status', {
        state: 'error',
        error: {
          message: error.message,
          type: error.type || 'SETUP_ERROR'
        }
      });
    }
  });

  // Handle WhatsApp status requests
  socket.on('whatsapp:status:get', async () => {
    try {
      const status = await matrixWhatsAppService.getStatus(userId);
      socket.emit('whatsapp:status', status);
    } catch (error) {
      logger.error('[WhatsApp Socket] Status check error:', error);
      socket.emit('whatsapp:status', {
        status: 'error',
        error: {
          message: error.message,
          type: error.type || 'STATUS_ERROR'
        }
      });
    }
  });

  // Handle WhatsApp disconnect requests
  socket.on('whatsapp:disconnect', async () => {
    try {
      await matrixWhatsAppService.disconnectWhatsApp(userId);
      socket.emit('whatsapp:status', {
        status: 'inactive',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('[WhatsApp Socket] Disconnect error:', error);
      socket.emit('whatsapp:status', {
        status: 'error',
        error: {
          message: error.message,
          type: error.type || 'DISCONNECT_ERROR'
        }
      });
    }
  });

  // Handle sync state updates
  socket.on('whatsapp:sync:state', (data) => {
    try {
      const { contactId } = data;
      if (!contactId) {
        throw new Error('No contact ID provided');
      }

      matrixWhatsAppService.syncMessages(userId, contactId);
    } catch (error) {
      logger.error('[WhatsApp Socket] Sync error:', error);
      socket.emit('whatsapp:sync_state', {
        state: 'error',
        error: {
          message: error.message,
          type: error.type || 'SYNC_ERROR'
        }
      });
    }
  });

  // Cleanup on disconnect
  socket.on('disconnect', async () => {
    try {
      if (setupTimeout) {
        clearTimeout(setupTimeout);
      }
      
      // Update connection status
      await matrixWhatsAppService.updateConnectionStatus(userId, 'inactive');
      
      logger.info('[WhatsApp Socket] Client disconnected:', userId);
    } catch (error) {
      logger.error('[WhatsApp Socket] Cleanup error:', error);
    }
  });

  // Error handling
  socket.on('error', (error) => {
    logger.error('[WhatsApp Socket] Socket error:', error);
    socket.emit('whatsapp:error', {
      message: error.message,
      type: error.type || 'SOCKET_ERROR'
    });
  });
};

// Helper to emit status updates to all connected clients for a user
export const emitStatusUpdate = (io, userId, status) => {
  try {
    io.to(`user:${userId}`).emit('whatsapp:status', {
      ...status,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('[WhatsApp Socket] Status broadcast error:', error);
  }
}; 