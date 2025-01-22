import { matrixWhatsAppService } from '../services/matrixWhatsAppService.js';
import { logger } from '../utils/logger.js';
import { adminClient } from '../utils/supabase.js';
import { tokenService } from '../services/tokenService.js';

const SETUP_TIMEOUT = 300000; // 5 minutes

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