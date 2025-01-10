import { Server } from 'socket.io';
import { adminClient } from '../utils/supabase.js';
import { ioEmitter } from '../utils/emitter.js';
import { validateDiscordToken, refreshDiscordToken } from './directServices/discordDirect.js';
import { matrixWhatsAppService}  from './matrixWhatsAppService.js';
import { whatsappEntityService } from '../services/whatsappEntityService.js';

export function initializeSocketServer(server) {
  const io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL || 'http://localhost:5173',
      credentials: true,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      exposedHeaders: ['Content-Range', 'X-Content-Range']
    },
    pingTimeout: 20000,
    pingInterval: 10000,
    transports: ['websocket', 'polling'],
    allowEIO3: true
  });

  // Add connection tracking
  const activeConnections = new Map();

  // Socket authentication middleware with better error handling
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      const userId = socket.handshake.auth.userId;

      console.log('Socket authentication attempt:', { 
        hasToken: !!token, 
        userId,
        socketId: socket.id
      });

      if (!token || !userId) {
        const error = new Error('Missing authentication credentials');
        error.data = { hasToken: !!token, hasUserId: !!userId };
        throw error;
      }

      // Check for existing connection
      const existingConnection = activeConnections.get(userId);
      if (existingConnection && existingConnection !== socket.id) {
        console.log('Disconnecting existing socket for user:', userId);
        const existingSocket = io.sockets.sockets.get(existingConnection);
        if (existingSocket) {
          existingSocket.disconnect(true);
        }
        activeConnections.delete(userId);
      }

      // Verify token with Supabase
      const { data: { user }, error: authError } = await adminClient.auth.getUser(token);
      
      if (authError || !user) {
        const error = new Error('Invalid authentication token');
        error.data = { authError };
        throw error;
      }

      // Verify userId matches
      if (user.id !== userId) {
        const error = new Error('User ID mismatch');
        error.data = { tokenUserId: user.id, socketUserId: userId };
        throw error;
      }

      // Get onboarding status
      const { data: onboarding, error: onboardingError } = await adminClient
        .from('user_onboarding')
        .select('current_step')
        .eq('user_id', userId)
        .single();

      if (onboardingError) {
        console.warn('Failed to fetch onboarding status:', onboardingError);
      }

      socket.user = user;
      socket.userId = userId;
      socket.onboardingStep = onboarding?.current_step || 'welcome';
      socket.status = 'active';

      // Track active connection
      activeConnections.set(userId, socket.id);

      console.log('Socket authenticated successfully:', {
        userId,
        socketId: socket.id,
        onboardingStep: socket.onboardingStep
      });

      next();
    } catch (error) {
      console.error('Socket authentication failed:', {
        error: error.message,
        data: error.data,
        socketId: socket.id,
        userId: socket.handshake.auth.userId
      });
      next(new Error(`Authentication failed: ${error.message}`));
    }
  });

  // Handle WhatsApp contact updates
  ioEmitter.on('whatsapp_contacts_updated', (data) => {
    const { userId, type } = data;
    io.to(`user:${userId}`).emit('whatsapp:contacts_updated', {
      type,
      timestamp: new Date().toISOString()
    });
  });

  // Handle new WhatsApp messages
  ioEmitter.on('whatsapp_message', async (data) => {
    const { userId, contactId, type } = data;
    
    try {
      // Get updated contact info
      const contact = await whatsappEntityService.getContacts(userId)
        .then(contacts => contacts.find(c => c.id === contactId));

      if (contact) {
        io.to(`user:${userId}`).emit('whatsapp:message', {
          type,
          contactId,
          unreadCount: contact.unread_count,
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      console.error('Error handling WhatsApp message event:', error);
    }
  });

  // Handle WhatsApp status updates
  ioEmitter.on('whatsapp_status_update', (data) => {
    const { userId, whatsappId, status } = data;
    io.to(`user:${userId}`).emit('whatsapp:status_update', {
      whatsappId,
      status,
      timestamp: new Date().toISOString()
    });
  });

  io.on('connection', (socket) => {
    const userId = socket.userId;
    let heartbeatTimeout;
    let disconnectTimeout;
    
    console.log('Client connected:', {
      userId,
      socketId: socket.id,
      onboardingStep: socket.onboardingStep
    });

    // Join user's room with correct format
    socket.join(`user:${userId}`);

    // Clear any existing timeouts for this user
    if (global.userTimeouts?.get(userId)) {
      const timeouts = global.userTimeouts.get(userId);
      clearTimeout(timeouts.heartbeat);
      clearTimeout(timeouts.disconnect);
      global.userTimeouts.delete(userId);
    }

    // Set up heartbeat
    heartbeatTimeout = setInterval(() => {
      if (socket.connected) {
        socket.emit('ping');
      }
    }, 30000);

    // Handle disconnection
    socket.on('disconnect', (reason) => {
      console.log('Client disconnecting:', {
        userId,
        socketId: socket.id,
        reason
      });

      // Clear heartbeat
      if (heartbeatTimeout) {
        clearInterval(heartbeatTimeout);
      }

      // Set disconnect timeout
      disconnectTimeout = setTimeout(() => {
        console.log('Client fully disconnected:', {
          userId,
          socketId: socket.id,
          reason
        });
        
        // Clean up user-specific resources
        if (socket.connectedPlatforms?.includes('matrix')) {
          // Handle Matrix cleanup if needed
        }
      }, 5000);

      // Store timeouts
      global.userTimeouts = global.userTimeouts || new Map();
      global.userTimeouts.set(userId, {
        heartbeat: heartbeatTimeout,
        disconnect: disconnectTimeout
      });

      // Clean up connection tracking
      if (activeConnections.get(userId) === socket.id) {
        activeConnections.delete(userId);
      }
    });

    // Handle reconnection
    socket.on('reconnect_attempt', (attemptNumber) => {
      console.log('Client reconnection attempt:', {
        userId,
        socketId: socket.id,
        attemptNumber
      });
    });

    // Handle Matrix-specific events only during matrix_setup
    if (socket.onboardingStep === 'matrix_setup') {
      socket.on('matrix_initialize', async (credentials) => {
        try {
          console.log('Matrix initialization requested:', {
            userId,
            socketId: socket.id
          });
          
          const result = await matrixWhatsAppService.initialize({
            userId,
            credentials,
            authToken: socket.handshake.auth.token
          });

          socket.emit('matrix_status', {
            status: 'success',
            ...result
          });
        } catch (error) {
          console.error('Matrix initialization failed:', {
            userId,
            socketId: socket.id,
            error: error.message
          });
          
          socket.emit('matrix_status', {
            status: 'error',
            message: error.message
          });
        }
      });
    }

    // Handle WhatsApp-specific events only during whatsapp_setup
    if (socket.onboardingStep === 'whatsapp_setup') {
      socket.on('whatsapp_connect', async () => {
        try {
          console.log('WhatsApp connection requested:', {
            userId,
            socketId: socket.id
          });
          
          const result = await matrixWhatsAppService.connectWhatsApp(userId);
          socket.emit('whatsapp_status', result);
      } catch (error) {
          console.error('WhatsApp connection failed:', {
            userId,
            socketId: socket.id,
            error: error.message
          });
          
          socket.emit('whatsapp_error', {
        message: error.message,
            code: error.code || 'UNKNOWN_ERROR'
          });
        }
      });
    }

    // Handle errors
    socket.on('error', (error) => {
      console.error('Socket error:', {
        userId,
        socketId: socket.id,
        error: error.message
      });
      
      socket.emit('socket_error', {
        message: error.message,
        code: error.code || 'SOCKET_ERROR'
      });
    });

    // Initial connection acknowledgment
    socket.emit('connect_status', {
      status: 'connected',
      userId,
      onboardingStep: socket.onboardingStep,
      timestamp: Date.now()
    });

    // Handle WhatsApp-specific events
    socket.on('whatsapp:request_sync', async (data) => {
      try {
        const { contactId } = data;
        await whatsappEntityService.requestSync(socket.userId, contactId);
        socket.emit('whatsapp:sync_requested', {
          contactId,
          status: 'pending',
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Error handling sync request:', error);
        socket.emit('whatsapp:error', {
          type: 'sync_request_failed',
          message: error.message
        });
      }
    });

    // Handle read receipts
    socket.on('whatsapp:mark_read', async (data) => {
      try {
        const { contactId, messageIds } = data;
        await whatsappEntityService.markMessagesAsRead(socket.userId, contactId, messageIds);
        socket.emit('whatsapp:messages_marked_read', {
          contactId,
          messageIds,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Error handling mark read:', error);
        socket.emit('whatsapp:error', {
          type: 'mark_read_failed',
          message: error.message
        });
      }
    });

    // Handle WhatsApp contact updates
    socket.on('whatsapp_contact_update', async (data) => {
      try {
        const { userId, contactId, type } = data;
        
        // Emit update to connected clients
        io.to(userId).emit('whatsapp_contact_update', {
          type,
          contactId,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Error handling WhatsApp contact update:', error);
      }
    });

    // Handle WhatsApp sync status changes
    socket.on('whatsapp_sync_status', async (data) => {
      try {
        const { userId, contactId, status } = data;
        
        // Emit status change to connected clients
        io.to(userId).emit('whatsapp_sync_status', {
          contactId,
          status,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Error handling WhatsApp sync status change:', error);
      }
    });

    // Handle WhatsApp unread count updates
    socket.on('whatsapp_unread_update', async (data) => {
      try {
        const { userId, contactId, unreadCount } = data;
        
        // Emit unread count update to connected clients
        io.to(userId).emit('whatsapp_unread_update', {
          contactId,
          unreadCount,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Error handling WhatsApp unread count update:', error);
      }
    });
  });

  return io;
} 