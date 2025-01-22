import sdk from 'matrix-js-sdk';
import { BRIDGE_CONFIGS, BRIDGE_TIMEOUTS } from '../config/bridgeConfig.js';
import { supabase, adminClient } from '../utils/supabase.js';
import { ioEmitter } from '../utils/emitter.js';
import { getIO } from '../utils/socket.js';
import {
  validateMatrixServer,
  validateCredentialsFormat,
  validateBridgeBot,
  validateUserPermissions,
  waitForBridgeBotJoin
} from '../utils/matrixValidation.js';
import { createClient } from 'redis';
import { redisConfig } from '../config/redis.js';
import { tokenService } from '../services/tokenService.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/backoff.js';
import RateLimit from 'async-ratelimiter';
import { promisify } from 'util';
import Redlock from 'redlock';

const SYNC_BATCH_SIZE = parseInt(process.env.MATRIX_SYNC_BATCH_SIZE || '50', 10);
const MAX_SYNC_BATCHES = parseInt(process.env.MATRIX_MAX_SYNC_BATCHES || '5', 10);
const MAX_SYNC_RETRIES = parseInt(process.env.MATRIX_SYNC_RETRIES || '3', 10);

const pubClient = createClient(redisConfig);
await pubClient.connect();

const redlock = new Redlock([pubClient], {
  driftFactor: 0.01,
  retryCount: 3,
  retryDelay: 200,
  retryJitter: 200
});

const ERROR_TYPES = {
  NETWORK: 'NETWORK_ERROR',
  AUTH: 'AUTH_ERROR',
  RATE_LIMIT: 'RATE_LIMIT',
  VALIDATION: 'VALIDATION_ERROR',
  SYNC: 'SYNC_ERROR',
  UNKNOWN: 'UNKNOWN_ERROR',
  RECOVERABLE: 'recoverable',
  PERMANENT: 'permanent'
};

const ERROR_BOUNDARIES = {
  CRITICAL: {
    MAX_RETRIES: 2,
    BACKOFF_MS: 5000,
    REQUIRES_ADMIN: true
  },
  RECOVERABLE: {
    MAX_RETRIES: 3,
    BACKOFF_MS: 2000,
    REQUIRES_ADMIN: false
  },
  TRANSIENT: {
    MAX_RETRIES: 5,
    BACKOFF_MS: 1000,
    REQUIRES_ADMIN: false
  }
};

const getErrorType = (error) => {
  if (error.name === 'ConnectionError' || error.code === 'ECONNREFUSED') {
    return ERROR_TYPES.NETWORK;
  }
  if (error.errcode === 'M_UNKNOWN_TOKEN' || error.errcode === 'M_MISSING_TOKEN') {
    return ERROR_TYPES.AUTH;
  }
  if (error.errcode === 'M_LIMIT_EXCEEDED') {
    return ERROR_TYPES.RATE_LIMIT;
  }
  if (error.message.includes('validation')) {
    return ERROR_TYPES.VALIDATION;
  }
  if (error.message.includes('sync')) {
    return ERROR_TYPES.SYNC;
  }
  return ERROR_TYPES.UNKNOWN;
};

const SYNC_STATES = {
  PREPARING: 'preparing',
  FETCHING: 'fetching',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  ERROR: 'error',
  RETRYING: 'retrying',
  OFFLINE: 'offline',
  RESUMING: 'resuming'
};

const CONNECTION_STATES = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  ERROR: 'error',
  CONNECTING: 'connecting'
};

const CONNECTION_HEALTH = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy'
};

const RATE_LIMITS = {
  SYNC: {
    MAX: 30,  // max requests
    DURATION: 60000,  // per minute
    BACKOFF: 2000  // base backoff in ms
  },
  TOKEN_REFRESH: {
    MAX: 5,
    DURATION: 60000,
    BACKOFF: 5000
  }
};

// Initialize rate limiters with Redis
const syncLimiter = new RateLimit({
  db: pubClient,
  max: RATE_LIMITS.SYNC.MAX,
  duration: RATE_LIMITS.SYNC.DURATION,
  namespace: 'matrix-sync'
});

const tokenLimiter = new RateLimit({
  db: pubClient,
  max: RATE_LIMITS.TOKEN_REFRESH.MAX,
  duration: RATE_LIMITS.TOKEN_REFRESH.DURATION,
  namespace: 'token-refresh'
});

class MatrixWhatsAppService {
  constructor() {
    this.matrixClients = new Map();
    this.connections = new Map();
    this.syncStates = new Map();
    this.messageHandlers = new Map();
    this.roomToContactMap = new Map();
    this.connectionAttempts = new Map();
    this.MAX_RECONNECT_ATTEMPTS = 3;
    this.RECONNECT_DELAY = 2000;
    this.bridgeRooms = new Map();
    this.connectionStates = new Map();
    this.healthCheckIntervals = new Map();
    this.reconnectAttempts = new Map();
    this.HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
    
    // Add error tracking
    this.errorCounts = new Map();
    this.lastErrors = new Map();
    this.errorThresholds = {
      RATE_LIMIT: 5,
      AUTH: 3,
      NETWORK: 10,
      SYNC: 5
    };
    
    // Use initialized rate limiters
    this.syncLimiter = syncLimiter;
    this.tokenLimiter = tokenLimiter;

    // Connection pool management
    this.connectionPool = {
      active: new Map(),
      idle: new Map(),
      MAX_IDLE: 10,
      MAX_ACTIVE: 100,
      IDLE_TIMEOUT: 300000 // 5 minutes
    };

    // Start pool maintenance
    this.startPoolMaintenance();

    // Add redlock
    this.redisLock = redlock;
  }

  validateMatrixClient = async (userId) => {
    try {
      console.log('Matrix client validation attempt:', {
        userId,
        matrixUserId: this.matrixClients.get(userId)?.getUserId()
      });
      
      // Verify the response matches our expected user ID
      if (whoamiResponse?.user_id !== this.matrixClients.get(userId)?.getUserId()) {
        throw new Error('User ID mismatch in whoami response');
      }

      console.log('Matrix client validation successful:', {
        userId,
        matrixUserId: this.matrixClients.get(userId)?.getUserId(),
        whoamiUserId: whoamiResponse.user_id
      });
      
      return true;
    } catch (error) {
      console.error(`Matrix client validation attempt failed:`, {
        error: error.message,
        userId,
        matrixUserId: this.matrixClients.get(userId)?.getUserId()
      });

      if (attempt === MAX_RETRIES - 1) {
        // On final attempt, try to clean up
        this.matrixClients.delete(userId);
        throw new Error(`Matrix client validation failed after ${MAX_RETRIES} attempts: ${error.message}`);
      }
    }
    return false;
  }

  restoreSession = async ({ userId, matrixCredentials }) => {
    try {
      console.log('=== Starting Matrix Session Restoration ===');
      console.log('Step 1: Validating input parameters:', {
        userId,
        matrixUserId: matrixCredentials?.userId
      });

      if (!userId || !matrixCredentials?.userId || !matrixCredentials?.accessToken) {
        throw new Error('Missing required parameters for session restoration');
      }

      // Get stored account data
      console.log('Step 2: Fetching stored account data');
      const { data: accountData, error: accountError } = await adminClient
        .from('accounts')
        .select('*')
        .eq('user_id', userId)
        .eq('platform', 'matrix')
        .single();

      if (accountError || !accountData) {
        throw new Error('No Matrix account found for user');
      }

      // Initialize Matrix client with stored credentials
      console.log('Step 3: Creating Matrix client instance');
      const matrixClient = sdk.createClient({
        baseUrl: accountData.credentials.homeserver,
        accessToken: matrixCredentials.accessToken,
        userId: matrixCredentials.userId,
        deviceId: matrixCredentials.deviceId,
        timeoutMs: 30000,
        retryIf: (attempt, error) => {
          console.log(`Matrix client retry attempt ${attempt}:`, error.message);
          return attempt < 3 && (
            error.name === 'ConnectionError' ||
            error.errcode === 'M_LIMIT_EXCEEDED' ||
            error.name === 'TimeoutError'
          );
        }
      });

      // Store client in memory first
      console.log('Step 4: Storing Matrix client in memory');
      this.matrixClients.set(userId, matrixClient);

      // Then validate the client
      console.log('Step 5: Validating Matrix client');
      await this.validateMatrixClient(userId);

      console.log('=== Matrix Session Restoration Completed Successfully ===');
      return {
        status: 'success',
        message: 'Matrix session restored successfully',
        data: {
          userId: matrixCredentials.userId,
          homeserver: accountData.credentials.homeserver,
          bridgeRoomId: accountData.credentials.bridge_room_id
        }
      };
    } catch (error) {
      // If validation fails, remove the client from memory
      this.matrixClients.delete(userId);

      console.error('=== Matrix Session Restoration Failed ===');
      console.error('Error details:', {
        message: error.message,
        stack: error.stack,
        userId,
        matrixUserId: matrixCredentials?.userId
      });
      throw error;
    }
  }

  initialize = async ({ userId, credentials, authToken }) => {
    try {
      logger.info('=== Starting Matrix Initialization ===');
      
      // Validate input credentials
      if (!credentials?.accessToken || !credentials?.userId) {
        logger.error('[MatrixService] Invalid Matrix credentials provided');
        throw new Error('M_INVALID_CREDENTIALS');
      }

      // Initialize Matrix client with proper credentials
      const matrixClient = sdk.createClient({
        baseUrl: credentials.homeserver || process.env.MATRIX_HOMESERVER_URL,
        accessToken: credentials.accessToken,
        userId: credentials.userId,
        deviceId: credentials.deviceId,
        timeoutMs: 60000,
        localTimeoutMs: 30000,
        validateCertificate: false
      });

      // Verify client can connect before storing
      try {
        await matrixClient.whoami();
      } catch (error) {
        logger.error('[MatrixService] Matrix client validation failed:', error);
        throw new Error('M_VALIDATION_FAILED');
      }

      // Store client instance
      this.matrixClients.set(userId, matrixClient);

      // Start client and wait for initial sync
      await matrixClient.startClient({
        initialSyncLimit: 10,
        includeArchivedRooms: false
      });

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Initial sync timed out'));
        }, 30000);

        matrixClient.once('sync', (state) => {
          if (state === 'PREPARED') {
            clearTimeout(timeout);
            resolve();
          }
        });
      });

      logger.info('[MatrixService] Client initialized successfully for user:', userId);
      return matrixClient;

    } catch (error) {
      logger.error('[MatrixService] Initialization failed:', error);
      throw error;
    }
  }

  updateConnectionStatus = async (userId, status, bridgeRoomId = null, options = {}) => {
    const lockKey = `whatsapp:status:${userId}`;
    
    try {
      // Acquire lock first
      const lock = await this.redisLock.acquire(lockKey, 30000); // 30s timeout
      
      logger.info('[Matrix Service] Status update requested:', {
        userId,
        currentStatus: status,
        bridgeRoomId,
        timestamp: new Date().toISOString(),
        options
      });

      // Get current account state
      const { data: existingAccount } = await adminClient
        .from('accounts')
        .select('status, credentials, metadata')
        .eq('user_id', userId)
        .eq('platform', 'whatsapp')
        .single();

      // Handle error state separately from inactive
      if (status === CONNECTION_STATES.ERROR) {
        const errorMetadata = {
          lastError: options.error || 'Unknown error',
          errorType: options.errorType || ERROR_TYPES.RECOVERABLE,
          errorTimestamp: new Date().toISOString(),
          isRecoverable: options.isRecoverable !== false
        };

        await this.updateAccountState(userId, {
          status: CONNECTION_STATES.ERROR,
          metadata: {
            ...(existingAccount?.metadata || {}),
            errors: [
              ...(existingAccount?.metadata?.errors || []).slice(-4),
              errorMetadata
            ]
          }
        });

        logger.error('[Matrix Service] Connection error recorded:', {
          userId,
          error: errorMetadata
        });

        await this.emitStatusUpdate(userId, CONNECTION_STATES.ERROR, bridgeRoomId);
        return true;
      }

      // If attempting to set inactive, validate carefully
      if (status !== CONNECTION_STATES.ACTIVE && bridgeRoomId) {
        // Try multiple times for sync issues
        const isValid = await this.validateBridgeRoomWithRetry(userId, bridgeRoomId);
        
        if (isValid) {
          logger.warn('[Matrix Service] Prevented incorrect inactive status - bridge room still valid', {
            userId,
            bridgeRoomId
          });
          return true;
        }
      }

      // Determine final status
      const finalStatus = bridgeRoomId ? CONNECTION_STATES.ACTIVE : CONNECTION_STATES.INACTIVE;

      // Only update if status actually changed
      if (existingAccount?.status !== finalStatus) {
        await this.updateAccountState(userId, {
          status: finalStatus,
          platform_user_id: bridgeRoomId || null,
          metadata: {
            ...(existingAccount?.metadata || {}),
            lastStatusChange: {
              from: existingAccount?.status,
              to: finalStatus,
              timestamp: new Date().toISOString(),
              reason: options.reason || 'explicit_update'
            }
          }
        });

        logger.info('[Matrix Service] Status updated:', {
          userId,
          oldStatus: existingAccount?.status,
          newStatus: finalStatus,
          bridgeRoomId,
          reason: options.reason
        });

        await this.emitStatusUpdate(userId, finalStatus, bridgeRoomId);
      }

      return true;
    } catch (error) {
      logger.error('[Matrix Service] Error updating connection status:', {
        userId,
        error,
        attempted_status: status
      });
      throw error;
    } finally {
      // Release lock
      await this.redisLock.release(lockKey).catch(error => {
        logger.error('[Matrix Service] Error releasing lock:', {
          userId,
          error
        });
      });
    }
  }

  updateAccountState = async (userId, updates) => {
    const { error } = await adminClient
      .from('accounts')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId)
      .eq('platform', 'whatsapp');

    if (error) {
      logger.error('[Matrix Service] Failed to update account:', {
        userId,
        updates,
        error
      });
      throw error;
    }
  }

  validateBridgeRoomWithRetry = async (userId, bridgeRoomId, maxAttempts = 3) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const matrixClient = this.matrixClients.get(userId);
        if (!matrixClient) return false;

        // Wait for sync if needed
        if (!matrixClient.isInitialSyncComplete()) {
          await new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(false), 5000);
            matrixClient.once('sync', (state) => {
              clearTimeout(timeout);
              resolve(state === 'PREPARED');
            });
          });
        }

        const room = matrixClient.getRoom(bridgeRoomId);
        if (!room) return false;

        // Check bridge bot presence using configured ID
        const bridgeBotId = BRIDGE_CONFIGS.whatsapp.bridgeBot;
        const members = room.getJoinedMembers();
        const botPresent = members.some(member => member.userId === bridgeBotId);

        logger.debug('[Matrix Service] Bridge room validation:', {
          userId,
          bridgeRoomId,
          attempt,
          botPresent,
          memberCount: members.length
        });

        return botPresent;

      } catch (error) {
        logger.warn('[Matrix Service] Validation attempt failed:', {
          userId,
          bridgeRoomId,
          attempt,
          error: error.message
        });

        if (attempt === maxAttempts) return false;
        await sleep(1000 * attempt);
      }
    }

    return false;
  }

  emitStatusUpdate = async (userId, status, bridgeRoomId) => {
    const statusData = {
      status,
      bridgeRoomId,
      timestamp: new Date().toISOString()
    };

    const io = getIO();
    if (io) {
      await io.to(`user:${userId}`).emit('whatsapp:status_update', {
        userId,
        ...statusData
      });
    }

    // Backup emission through Redis
    ioEmitter.emit('whatsapp:status_update', {
      userId,
      ...statusData
    });
  }

  connectWhatsApp = async (userId) => {
    try {
      console.log('=== Starting WhatsApp Connection Flow ===');
      
      // Update status to connecting
      await this.updateConnectionStatus(userId, 'connecting');

      console.log('Step 1: Validating Matrix client for user:', userId);
      const matrixClient = this.matrixClients.get(userId);
      if (!matrixClient) {
        throw new Error('Matrix client not initialized. Please connect to Matrix first.');
      }

      // Ensure client is started and synced
      console.log('Step 2: Ensuring Matrix client is synced...');
      if (!matrixClient.clientRunning) {
        console.log('Starting Matrix client...');
        await matrixClient.startClient({
          initialSyncLimit: 10
        });
      }

      // Wait for initial sync with extended timeout
      await new Promise((resolve, reject) => {
        const syncTimeout = setTimeout(() => {
          reject(new Error('Matrix sync timeout'));
        }, 60000); // 60 seconds for initial sync

        if (matrixClient.isInitialSyncComplete()) {
          clearTimeout(syncTimeout);
          resolve();
        } else {
          matrixClient.once('sync', (state) => {
            clearTimeout(syncTimeout);
            if (state === 'PREPARED') {
              resolve();
            } else {
              reject(new Error(`Sync failed with state: ${state}`));
            }
          });
        }
      });

      console.log('Matrix client synced successfully');

      // Validate bridge bot availability
      console.log('Step 3: Validating bridge bot...');
      const bridgeBotValidation = await validateBridgeBot(matrixClient);
      if (!bridgeBotValidation.valid) {
        throw new Error(`Bridge bot validation failed: ${bridgeBotValidation.error}`);
      }
      console.log('Bridge bot validation successful:', bridgeBotValidation.status);

      // Create bridge room with retries
      console.log('Step 4: Creating bridge room...');
      let bridgeRoom;
      let attempts = 0;
      const maxAttempts = 3;

      while (attempts < maxAttempts) {
        try {
          bridgeRoom = await matrixClient.createRoom({
            visibility: 'private',
            name: `WhatsApp Bridge - ${userId}`,
            topic: 'WhatsApp Bridge Connection Room',
            invite: [BRIDGE_CONFIGS.whatsapp.bridgeBot],
            preset: 'private_chat',
            initial_state: [{
              type: 'm.room.guest_access',
              state_key: '',
              content: { guest_access: 'forbidden' }
            }]
          });
          break;
        } catch (error) {
          attempts++;
          if (attempts === maxAttempts) throw error;
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      console.log('Bridge room created:', bridgeRoom.room_id);

      // Wait for room to be properly synced
      console.log('Step 5: Waiting for room to be synced...');
      await new Promise((resolve, reject) => {
        const roomTimeout = setTimeout(() => {
          reject(new Error('Room sync timeout'));
        }, 10000);

        const checkRoom = () => {
          const roomObj = matrixClient.getRoom(bridgeRoom.room_id);
          if (roomObj) {
            clearTimeout(roomTimeout);
            resolve();
          } else {
            setTimeout(checkRoom, 500);
          }
        };
        checkRoom();
      });

      // Verify room state
      const roomObj = matrixClient.getRoom(bridgeRoom.room_id);
      console.log('Room state:', {
        roomId: bridgeRoom.room_id,
        name: roomObj.name,
        joinedMembers: roomObj.getJoinedMembers().map(m => m.userId)
      });

      // Send login command
      console.log('Step 6: Sending bridge initiation message...');
      try {
        await matrixClient.sendMessage(bridgeRoom.room_id, {
          msgtype: 'm.text',
          body: '!wa login qr'
        });
        console.log('Bridge initiation message sent');

        // Emit room ID to client immediately after room creation
        const io = getIO();
        if (!io) {
          console.error('Socket.IO instance not found');
          throw new Error('Socket communication error');
        }

        // Emit to specific user's socket
        const userSockets = Array.from(io.sockets.sockets.values())
          .filter(socket => socket.userId === userId);

        console.log('Found user sockets:', userSockets.length);

        // Emit awaiting_scan immediately instead of pending
        userSockets.forEach(socket => {
          console.log('Emitting whatsapp_status to socket:', socket.id);
          socket.emit('whatsapp_status', {
            userId,
            status: 'awaiting_scan',
            bridgeRoomId: bridgeRoom.room_id
          });
        });

        // Also emit through the event emitter as backup
        ioEmitter.emit('whatsapp_status', {
          userId,
          status: 'awaiting_scan',
          bridgeRoomId: bridgeRoom.room_id
        });

      } catch (error) {
        console.error('Failed to send bridge initiation message:', error);
        await matrixClient.leave(bridgeRoom.room_id);
        throw new Error('Failed to initiate bridge. Please try again.');
      }

      // Set up message handling and QR code generation with extended timeout
      return new Promise((resolve, reject) => {
        let qrCodeReceived = false;
        let connectionTimeout;
        let qrTimeout;

        const cleanup = () => {
          clearTimeout(connectionTimeout);
          clearTimeout(qrTimeout);
          // matrixClient.removeListener('Room.timeline', handleResponse);
          matrixClient.removeListener('Room.timeline', debugListener);
        };

        // Set overall connection timeout (5 minutes)
        connectionTimeout = setTimeout(() => {
          cleanup();
          reject(new Error('WhatsApp connection timeout - Please try again'));
        }, 300000); // 5 minutes

        // Set QR code timeout
        qrTimeout = setTimeout(() => {
          if (!qrCodeReceived) {
            cleanup();
            reject(new Error('QR code not received within expected time'));
          }
        }, 60000); // 1 minute to receive QR code

        console.log('Step 7: Setting up message handlers...');

        // Debug listener for all timeline events
        const debugListener = (event, room) => {
          if (room.roomId !== bridgeRoom.room_id) return;
          if (event.getSender() !== BRIDGE_CONFIGS.whatsapp.bridgeBot) return;

          console.log('Got timeline event:', {
            roomId: room.roomId,
            sender: event.getSender(),
            eventType: event.getType(),
            msgtype: event.getContent().msgtype,
            body: event.getContent().body
          });

          if (event.getType() === 'm.room.message') {
            const body = event.getContent().body;
            if (body && body.includes('Successfully logged in as')) {
              const io = getIO();
              if (io) {
                const userSockets = Array.from(io.sockets.sockets.values())
                  .filter(socket => socket.userId === userId);

                const successData = {
                  userId,
                  status: 'connected',
                  bridgeRoomId: bridgeRoom.room_id,
                  qrReceived: true
                };

                // Emit to all user sockets
                const emitPromises = userSockets.map(socket => {
                  return new Promise((emitResolve) => {
                    console.log('Emitting "connected" status to socket:', socket.id);
                    socket.emit('whatsapp_status', successData, () => {
                      // Acknowledgment callback
                      emitResolve();
                    });
                  });
                });

                // Wait for all emissions to complete
                Promise.all(emitPromises)
                .then(() => {
                  console.log('Successfully emitted to all sockets');
                  // setTimeout(() => {
                  //   console.log('Performing delayed cleanup...');
                  //   cleanup();
                  // }, 2000); 
                  cleanup();
                  resolve(successData);  // Resolve the promise with success data
                })
                .catch((error) => {
                  console.error('Error in socket emission:', error);
                  // Still resolve as the connection was successful
                  cleanup();
                  resolve(successData);
                });
                
              } 
            } 
          }

          
        };
        matrixClient.on('Room.timeline', debugListener);
        matrixClient.on('Room.timeline', debugListener);

        

        // const handleResponse = async (event, room) => {
        //   if (room.roomId !== bridgeRoom.room_id) {
        //     console.log('Ignoring event from different room:', room.roomId);
        //     return;
        //   }
        //   if (event.getSender() !== BRIDGE_CONFIGS.whatsapp.bridgeBot) {
        //     console.log('Ignoring event from non-bridge sender:', event.getSender());
        //     return;
        //   }

        //   const content = event.getContent();
        //   console.log('Processing event from bridge bot:', {
        //     type: event.getType(),
        //     msgtype: content.msgtype,
        //     hasBody: !!content.body,
        //     url: content.url
        //   });

        //   // Handle QR code image
        //   if (content.msgtype === 'm.image') {
        //     qrCodeReceived = true;
        //     clearTimeout(qrTimeout); // Clear QR timeout once received
        //     console.log('Step 8: QR code image received in Element');
            
        //     // Emit awaiting_scan status to all user's sockets
        //     const io = getIO();
        //     if (io) {
        //       const userSockets = Array.from(io.sockets.sockets.values())
        //         .filter(socket => socket.userId === userId);
              
        //       userSockets.forEach(socket => {
        //         console.log('Emitting awaiting_scan status to socket:', socket.id);
        //         socket.emit('whatsapp_status', {
        //           userId,
        //           status: 'awaiting_scan',
        //           bridgeRoomId: bridgeRoom.room_id,
        //           qrReceived: true
        //         });
        //       });
        //     }

        //     // Also emit through event emitter for redundancy
        //     ioEmitter.emit('whatsapp_status', {
        //       userId,
        //       status: 'awaiting_scan',
        //       bridgeRoomId: bridgeRoom.room_id,
        //       qrReceived: true
        //     });

        //     return;
        //   }

        //   // Handle text messages
        //   if (event.getType() === 'm.room.message' && content.msgtype === 'm.text') {
        //     const messageText = content.body;
        //     console.log('Processing text message:', messageText);

        //     // Handle successful connection with more specific matching
        //     const loginMatch = messageText.match(/Successfully logged in as (\+\d+)/);
        //     const alternateLoginMatch = messageText.match(/Logged in as (\+\d+)/);
        //     const phoneNumberMatch = loginMatch || alternateLoginMatch;

        //     if (phoneNumberMatch || 
        //         messageText.includes('WhatsApp connection established') || 
        //         messageText.includes('Connected to WhatsApp') ||
        //         messageText.includes('Login successful')) {
              
        //       // Only proceed if we have explicit login confirmation with phone number
        //       if (!phoneNumberMatch) {
        //         console.log('Received connection confirmation, waiting for login message with phone number...');
        //         return;
        //       }

        //       console.log('Step 9: WhatsApp connection successful with phone number');
              
        //       // Extract phone number from either match pattern
        //       const phoneNumber = phoneNumberMatch[1];
        //       console.log('Extracted phone number:', phoneNumber);

        //       // Emit success through all available channels
        //       console.log('Step 10: Emitting success status with login confirmation');
        //       const successData = {
        //         userId,
        //         status: 'connected',
        //         bridgeRoomId: bridgeRoom.room_id,
        //         phoneNumber,
        //         loginMessage: messageText
        //       };

        //       // Emit through socket.io
        //       const io = getIO();
        //       if (io) {
        //         const userSockets = Array.from(io.sockets.sockets.values())
        //           .filter(socket => socket.userId === userId);
                
        //         userSockets.forEach(socket => {
        //           console.log('Emitting success to socket:', socket.id);
        //           socket.emit('whatsapp_status', successData);
        //         });
        //       }

        //       // Also emit through event emitter
        //       ioEmitter.emit('whatsapp_status', successData);

        //       // Update database
        //       console.log('Step 11: Updating database with connection details');
        //       try {
        //         const { error } = await adminClient
        //           .from('accounts')
        //           .upsert({
        //             user_id: userId,
        //             platform: 'whatsapp',
        //             status: 'active',
        //             credentials: {
        //               bridge_room_id: bridgeRoom.room_id,
        //               phone_number: phoneNumber
        //             },
        //             connected_at: new Date().toISOString()
        //           });

        //         if (error) {
        //           console.error('Database update failed:', error);
        //           // Even if DB update fails, connection is successful
        //           console.log('Connection successful despite DB error');
        //         }

        //         // Store connection info
        //         this.connections.set(userId, {
        //           bridgeRoomId: bridgeRoom.room_id,
        //           matrixClient,
        //           phoneNumber
        //         });

        //         cleanup();
        //         resolve(successData);
        //       } catch (dbError) {
        //         console.error('Database operation failed:', dbError);
        //         // Still consider connection successful
        //         cleanup();
        //         resolve(successData);
        //       }
        //     }

        //     // Handle connection errors with more specific messages
        //     if (messageText.toLowerCase().includes('error') || 
        //         messageText.toLowerCase().includes('failed') ||
        //         messageText.toLowerCase().includes('timeout')) {
        //       console.error('WhatsApp connection error:', messageText);
        //       cleanup();
              
        //       let errorMessage = 'Connection failed';
        //       if (messageText.toLowerCase().includes('timeout')) {
        //         errorMessage = 'Connection timed out. Please try again.';
        //       } else if (messageText.toLowerCase().includes('invalid')) {
        //         errorMessage = 'Invalid QR code or connection request. Please try again.';
        //       }
              
        //       reject(new Error(errorMessage));
        //     }
        //   }
        // };

        // matrixClient.on('Room.timeline', handleResponse);
      });

      // Update status to connected
      await this.updateConnectionStatus(userId, 'connected', bridgeRoom.room_id);

      // Store connection in memory
      this.connections.set(userId, {
        matrixClient,
        bridgeRoomId: bridgeRoom.room_id,
        status: 'connected'
      });

    } catch (error) {
      // Clean up any partial connection state
      this.connections.delete(userId);
      
      await this.updateConnectionStatus(userId, 'error');
      console.error('=== WhatsApp Connection Flow Failed ===', error);
      throw error;
    }
  }

  disconnectWhatsApp = async (userId) => {
    try {
      const connection = this.connections.get(userId);
      if (!connection) {
        throw new Error('No active WhatsApp connection found');
      }

      // Update status in memory first
      connection.status = 'inactive';

      const { matrixClient, bridgeRoomId } = connection;

      // Send logout command
      await matrixClient.sendMessage(bridgeRoomId, {
        msgtype: 'm.text',
        body: BRIDGE_CONFIGS.whatsapp.logoutCommand
      });

      // Update account status to inactive
      await this.updateConnectionStatus(userId, 'inactive');

      // Clean up connection
      this.connections.delete(userId);

      return true;
    } catch (error) {
      console.error('[Matrix Service] Error disconnecting WhatsApp:', error);
      throw error;
    }
  }

  checkBotPresence = async (matrixClient, bridgeRoomId) => {
    try {
      if (!matrixClient || !bridgeRoomId) {
        console.log('[Matrix Service] Invalid parameters for bot presence check:', {
          hasClient: !!matrixClient,
          roomId: bridgeRoomId
        });
        return false;
      }

      const room = matrixClient.getRoom(bridgeRoomId);
      if (!room) {
        console.log('[Matrix Service] Bridge room not found:', bridgeRoomId);
        return false;
      }

      const bridgeBot = room.getMember(BRIDGE_CONFIGS.whatsapp.bridgeBot);
      if (!bridgeBot || bridgeBot.membership !== 'join') {
        console.log('[Matrix Service] Bridge bot not present or not joined:', {
          roomId: bridgeRoomId,
          botPresent: !!bridgeBot,
          membership: bridgeBot?.membership
        });
        return false;
      }

      return true;
    } catch (error) {
      console.error('[Matrix Service] Error checking bot presence:', error);
      return false;
    }
  }

  cleanupStaleConnection = async (userId, bridgeRoomId) => {
    try {
      console.log('[Matrix Service] Cleaning up stale connection:', {
        userId,
        bridgeRoomId
      });

      // Remove in-memory connection
      this.connections.delete(userId);
      
      // Update database status to inactive
                await this.updateConnectionStatus(userId, 'inactive');
      
      // Clear connection attempts
      this.connectionAttempts.delete(userId);

      // Update account record with empty credentials object (as JSONB)
      const { error: updateError } = await adminClient
        .from('accounts')
        .update({
          status: 'inactive',
          credentials: {},  // Pass as object, not string, for JSONB
          platform_user_id: null,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('platform', 'whatsapp');

      if (updateError) {
        console.error('[Matrix Service] Error updating account record:', updateError);
        throw updateError;
      }

      return true;
          } catch (error) {
      console.error('[Matrix Service] Error cleaning up stale connection:', error);
      throw error;
    }
  }

  getStatus = async (userId) => {
    try {
      console.log('Getting WhatsApp status for user:', userId);
      
      // Get Matrix client
      const matrixClient = this.matrixClients.get(userId);
      if (!matrixClient) {
        return { status: 'error', error: 'Matrix client not initialized' };
      }

      // Get bridge room
      const bridgeRoom = await this.getBridgeRoom(userId);
      if (!bridgeRoom) {
        return { status: 'inactive', bridgeRoomId: null };
      }

      // Check if bridge bot is still in the room
      const members = bridgeRoom.getJoinedMembers();
      const bridgeBotPresent = members.some(member => 
        member.userId === BRIDGE_CONFIGS.whatsapp.bridgeBot
      );

      if (!bridgeBotPresent) {
        return { status: 'error', error: 'Bridge bot not found in room' };
      }

      // Get WhatsApp connection status from room state
      const whatsappState = bridgeRoom.currentState.getStateEvents('m.room.whatsapp')[0];
      const isConnected = whatsappState?.getContent()?.connected === true;

      return {
        status: isConnected ? 'active' : 'pending',
        bridgeRoomId: bridgeRoom.roomId
      };
    } catch (error) {
      console.error('Error getting WhatsApp status:', error);
      return { status: 'error', error: error.message };
    }
  }

  getStatusMessage = (status, connection) => {
    switch (status) {
      case 'active':
        return connection ? 'WhatsApp connection is active' : 'WhatsApp connection needs restoration';
      case 'inactive':
        return 'WhatsApp is not connected';
      case 'reconnecting':
        return 'Restoring WhatsApp connection';
      case 'error':
        return 'WhatsApp connection error';
      default:
        return 'Unknown WhatsApp connection state';
    }
  }

  setupMessageSync = async (userId, matrixClient) => {
    console.log('Setting up Matrix message sync for user:', userId);
    
    try {
      // Get all WhatsApp contacts for the user to build room mapping
      const { data: contacts, error: contactError } = await adminClient
        .from('whatsapp_contacts')
        .select('id, whatsapp_id, metadata')
        .eq('user_id', userId);

      if (contactError) throw contactError;

      // Build room to contact mapping
      contacts.forEach(contact => {
        if (contact.metadata?.room_id) {
          this.roomToContactMap.set(contact.metadata.room_id, {
            contactId: contact.id,
            whatsappId: contact.whatsapp_id
          });
        }
      });

      // Set up timeline listener for all rooms
      matrixClient.on('Room.timeline', async (event, room, toStartOfTimeline) => {
        try {
          // Skip if not a message event
          if (event.getType() !== 'm.room.message') return;
          
          // Skip if from bridge bot or self
          if (event.getSender() === BRIDGE_CONFIGS.whatsapp.bridgeBot ||
              event.getSender() === matrixClient.getUserId()) return;

          // Get contact info from room
          const contactInfo = this.roomToContactMap.get(room.roomId);
          if (!contactInfo) {
            console.log('[Matrix Service] No contact mapping found for room:', room.roomId);
            return;
          }

          const content = event.getContent();
          if (!content || !content.body) return;

          // Prepare message data
          const messageData = {
            user_id: userId,
            contact_id: contactInfo.contactId,
            message_id: event.getId(),
            content: content.body,
            sender_id: event.getSender(),
            sender_name: room.getMember(event.getSender())?.name || event.getSender(),
            message_type: content.msgtype === 'm.text' ? 'text' : 'media',
            metadata: {
              room_id: room.roomId,
              event_id: event.getId(),
              raw_event: event.event
            },
            timestamp: new Date(event.getTs()).toISOString(),
            is_read: false
          };

          // Store message in database with retry
          let retryCount = 0;
          while (retryCount < 3) {
            try {
              const { error: insertError } = await adminClient
                .from('whatsapp_messages')
                .upsert(messageData, {
                  onConflict: 'user_id,message_id',
                  returning: true
                });

              if (!insertError) {
                // Update sync status and emit event
                await this.updateSyncStatus(userId, contactInfo.contactId, 'approved');
                global.io?.to(`user:${userId}`).emit('whatsapp:message', messageData);
                break;
              }

              retryCount++;
              if (retryCount < 3) {
                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
              }
            } catch (err) {
              console.error('[Matrix Service] Error storing message (attempt ${retryCount + 1}):', err);
              retryCount++;
              if (retryCount === 3) throw err;
              await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
            }
          }
        } catch (error) {
          console.error('[Matrix Service] Error processing timeline event:', error);
        }
      });

      // Set up reconnection handler
      matrixClient.on('sync', async (state, prevState, data) => {
        console.log('[Matrix Service] Sync state changed:', {
          state,
          prevState,
          timestamp: new Date().toISOString(),
          error: state === 'ERROR' ? data?.error : undefined
        });
        
        if (state === 'ERROR') {
          console.error('[Matrix Service] Sync error:', {
            error: data.error,
            syncState: state,
            prevState,
            timestamp: new Date().toISOString()
          });

          // Clear any existing handlers to prevent duplicate events
          matrixClient.removeAllListeners('Room.timeline');
          
          // Implement exponential backoff for retries
          const retryDelay = Math.min(1000 * Math.pow(2, this.syncRetryCount || 0), 32000);
          this.syncRetryCount = (this.syncRetryCount || 0) + 1;
          
          console.log(`[Matrix Service] Attempting reconnect in ${retryDelay}ms (attempt ${this.syncRetryCount})`);
          
          setTimeout(async () => {
            try {
              // First try to verify the connection
              const whoamiResponse = await matrixClient.whoami();
              if (!whoamiResponse?.user_id) {
                throw new Error('Invalid whoami response');
              }

              console.log('[Matrix Service] Connection verified, attempting to resume sync...');
              await matrixClient.startClient({
                initialSyncLimit: 10,
                includeArchivedRooms: false
              });
            } catch (err) {
              console.error('[Matrix Service] Reconnection failed:', err);
              
              // If we've tried too many times, force a full restart
              if (this.syncRetryCount >= 5) {
                console.log('[Matrix Service] Too many retry attempts, forcing full restart');
                this.syncRetryCount = 0;
                await this.restartMatrixClient(userId);
              }
            }
          }, retryDelay);
        } else if (state === 'PREPARED') {
          console.log('[Matrix Service] Sync prepared successfully');
          this.syncRetryCount = 0;
          
          // Re-setup timeline listeners if needed
          this.setupTimelineListeners(userId, matrixClient);
        }
      });

      console.log('Message sync setup completed for user:', userId);
      return true;
    } catch (error) {
      console.error('Error setting up message sync:', error);
      throw error;
    }
  }

  syncMessages = async (userId, contactId, retryCount = 0) => {
    const syncKey = `sync:${userId}:${contactId}`;
    let currentBatchRetries = 0;
    const MAX_BATCH_RETRIES = 3;
    
    try {
      // Check for existing sync state
      const existingState = await pubClient.get(syncKey);
      if (existingState) {
        const state = JSON.parse(existingState);
        if (state.state === SYNC_STATES.PROCESSING || state.state === SYNC_STATES.RETRYING) {
          console.log('[Matrix Service] Sync already in progress:', state);
          return state;
        }
      }

      // Initialize sync state
      await this.updateSyncProgress(syncKey, {
        state: SYNC_STATES.PREPARING,
        progress: 0,
        startedAt: Date.now(),
        totalMessages: 0,
        processedMessages: 0,
        errors: [],
        retryCount,
        batchRetries: 0
      });

      // ... rest of existing sync logic ...

      // Handle offline scenario
      if (!global.io?.sockets?.adapter?.rooms?.get(`user:${userId}`)) {
        await this.updateSyncProgress(syncKey, {
          state: SYNC_STATES.OFFLINE,
          details: 'User offline, sync will resume when online'
        });
        return;
      }

      // ... rest of existing sync logic ...

    } catch (error) {
      const errorType = getErrorType(error);
      
      // Update sync state with error
      await this.updateSyncProgress(syncKey, {
        state: SYNC_STATES.ERROR,
        error: error.message,
        errorType,
        completedAt: Date.now()
      });

      throw error;
    }
  }

  processMessageEvent = async (userId, contactId, event) => {
    // Skip messages from bridge bot
    if (event.getSender() === BRIDGE_CONFIGS.whatsapp.bridgeBot) {
      console.log('[Matrix Service] Skipping bridge bot message:', event.getId());
      return null;
    }

    const content = event.getContent();
    
    // Skip bot commands and responses
    if (content.body && (content.body.startsWith('!wa') || content.body.startsWith('Successfully logged in'))) {
      console.log('[Matrix Service] Skipping bot command/response:', event.getId());
      return null;
    }

    console.log('[Matrix Service] Processing message event:', {
      eventId: event.getId(),
      type: content.msgtype,
      timestamp: event.getTs()
    });

    const messageData = {
      user_id: userId,
      contact_id: contactId,
      message_id: event.getId(),
      content: content.body || JSON.stringify(content),
      sender_id: event.getSender(),
      timestamp: new Date(event.getTs()).toISOString(),
      is_read: false,
      message_type: content.msgtype === 'm.text' ? 'text' : 'media',
      metadata: {
        raw_event: {
          type: event.getType(),
          content: content,
          origin_server_ts: event.getTs()
        }
      }
    };

    const { error: insertError } = await adminClient
      .from('whatsapp_messages')
      .upsert(messageData, {
        onConflict: 'user_id,message_id'
      });

    if (insertError) {
      throw insertError;
    }

    return messageData;
  }

  updateSyncStatus = async (userId, contactId, status, error = null) => {
    try {
      // Validate status against allowed values
      const validStatuses = ['pending', 'approved', 'rejected'];
      if (!validStatuses.includes(status)) {
        throw new Error(`Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
      }

      // Get current sync request
      const { data: currentSync, error: fetchError } = await adminClient
        .from('whatsapp_sync_requests')
        .select('status, metadata')
        .eq('user_id', userId)
        .eq('contact_id', contactId)
        .single();

      if (fetchError && !fetchError.message.includes('not found')) {
        console.error('[Matrix Service] Error fetching current sync status:', fetchError);
        throw fetchError;
      }

      // Prepare metadata
      const metadata = {
        ...(currentSync?.metadata || {}),
        last_updated: new Date().toISOString(),
        is_processing: status === 'pending'
      };

      if (error) {
        metadata.error = error.message;
        metadata.failed_at = new Date().toISOString();
      }

      if (status === 'approved') {
        metadata.sync_completed_at = new Date().toISOString();
        metadata.is_processing = false;
      }

      // Update sync status with metadata
      const { error: updateError } = await adminClient
        .from('whatsapp_sync_requests')
        .upsert({
          user_id: userId,
          contact_id: contactId,
          status,
          approved_at: status === 'approved' ? new Date().toISOString() : null,
          metadata
        }, {
          onConflict: 'user_id,contact_id'
        });

      if (updateError) {
        console.error('[Matrix Service] Failed to update sync status:', updateError);
        throw updateError;
      }

      console.log(`[Matrix Service] Sync status updated to ${status} for contact ${contactId}`);
    } catch (error) {
      console.error('[Matrix Service] Error in updateSyncStatus:', error);
      throw error;
    }
  }

  getMatrixClient = async (userId) => {
    try {
      // Check active connections first
      let client = this.connectionPool.active.get(userId);
      if (client) {
        return client;
      }

      // Check idle connections
      client = this.connectionPool.idle.get(userId);
      if (client) {
        // Move to active pool
        this.connectionPool.idle.delete(userId);
        this.connectionPool.active.set(userId, client);
        return client;
      }

      // Check connection pool limits
      if (this.connectionPool.active.size >= this.connectionPool.MAX_ACTIVE) {
        throw new Error('Connection pool limit reached');
      }

      // Apply rate limiting for new connections
      const rateLimitResult = await this.syncLimiter.get({ id: userId });
      if (!rateLimitResult.remaining) {
        const retryAfter = Math.ceil((rateLimitResult.reset - Date.now()) / 1000);
        throw new Error(`Rate limit exceeded. Retry after ${retryAfter} seconds`);
      }

      // Get valid token with rate limiting
      const tokenLimitResult = await this.tokenLimiter.get({ id: userId });
      if (!tokenLimitResult.remaining) {
        const retryAfter = Math.ceil((tokenLimitResult.reset - Date.now()) / 1000);
        throw new Error(`Token refresh rate limit exceeded. Retry after ${retryAfter} seconds`);
      }

      const tokenData = await tokenService.getValidToken();
      if (!tokenData) {
        throw new Error('No valid token available');
      }

      // Initialize new client
      client = sdk.createClient({
        baseUrl: process.env.MATRIX_SERVER_URL,
        accessToken: tokenData.access_token,
        userId: `@${userId}:${process.env.MATRIX_SERVER_DOMAIN}`,
        timeoutMs: 10000,
        localTimeoutMs: 10000
      });

      // Enhanced token subscription with rate limiting
      const unsubscribe = tokenService.subscribe(async (newTokenData) => {
        try {
          const limitResult = await this.tokenLimiter.get({ id: userId });
          if (!limitResult.remaining) {
            logger.warn('[Matrix Service] Token refresh rate limited:', {
              userId,
              resetIn: Math.ceil((limitResult.reset - Date.now()) / 1000)
            });
            return;
          }

          client.setAccessToken(newTokenData.access_token);
          await this.validateMatrixClient(userId);
          
          logger.info('[Matrix Service] Updated access token:', {
            userId,
            tokenExpiry: newTokenData.expires_at
          });
        } catch (error) {
          await this.handleError(userId, error, {
            context: 'token_update',
            tokenExpiry: newTokenData.expires_at
          });
        }
      });

      // Store in active pool
      this.connectionPool.active.set(userId, {
        client,
        unsubscribe,
        lastUsed: Date.now()
      });

      // Set up client event handlers with enhanced monitoring
      client.once('sync', (state) => {
        if (state === 'ERROR') {
          this.handleError(userId, new Error('Sync failed'), {
            context: 'sync',
            state
          });
        } else {
          this.updateConnectionState(userId, CONNECTION_STATES.CONNECTED);
        }
      });

      await client.startClient();
      
      return client;
    } catch (error) {
      logger.error('[Matrix Service] Failed to get Matrix client:', error);
      
      const recovery = await this.handleError(userId, error, {
        context: 'client_initialization'
      });
      
      if (recovery.shouldRetry) {
        await sleep(recovery.backoffMs);
        return this.getMatrixClientWithRetry(userId);
      }
      
      throw error;
    }
  }

  getMatrixClientWithRetry = async (userId, retryCount = 0) => {
    const MAX_RETRIES = 3;
    const BASE_DELAY = 2000;

    try {
      return await this.getMatrixClient(userId);
    } catch (error) {
      if (retryCount >= MAX_RETRIES) {
        logger.error('[Matrix Service] Max retries exceeded for getting Matrix client:', {
          userId,
          retryCount,
          error: error.message
        });
        throw error;
      }

      const delay = BASE_DELAY * Math.pow(2, retryCount);
      await sleep(delay);
      
      logger.info('[Matrix Service] Retrying Matrix client initialization:', {
        userId,
        retryCount: retryCount + 1,
        delay
      });
      
      return this.getMatrixClientWithRetry(userId, retryCount + 1);
    }
  }

  restoreConnection = async (userId, credentials) => {
    try {
      console.log('Attempting to restore WhatsApp connection for user:', userId);
      
      // First validate/initialize Matrix client
      const matrixClient = await this.initializeMatrixClient(credentials);
      
      // Then attempt to restore WhatsApp connection
      await this.connectWhatsApp(userId);
      
      // Clear connection attempts on success
      this.connectionAttempts.delete(userId);
      
      return true;
    } catch (error) {
      console.error('Failed to restore connection:', error);
      throw error;
    }
  }

  handleBotInvite = async (userId, roomId) => {
    try {
      console.log('[Matrix] Handling bot invite for room:', roomId);
      
      const matrixClient = this.matrixClients.get(userId);
      if (!matrixClient) {
        throw new Error('Matrix client not initialized');
      }

      // Get room state
      const room = matrixClient.getRoom(roomId);
      if (!room) {
        throw new Error('Room not found');
      }

      // Check if bridge bot is in the room
      const bridgeBot = room.currentState.getMember(BRIDGE_CONFIGS.whatsapp.bridgeBot);
      if (!bridgeBot) {
        throw new Error('Bridge bot not found in room');
      }

      // Skip if this is the bridge control room
      if (roomId === BRIDGE_CONFIGS.whatsapp.bridgeRoomId) {
        console.log('[Matrix] Skipping bridge control room:', roomId);
        return false;
      }

      // Check if this is a valid WhatsApp chat room
      const roomName = room.name;
      const isWhatsAppRoom = roomName && (
        roomName.includes('(WA)') || 
        roomName.match(/\+\d{10,}/) || 
        room.currentState.getStateEvents('m.room.whatsapp').length > 0
      );

      if (!isWhatsAppRoom) {
        console.log('[Matrix] Not a WhatsApp chat room, skipping:', roomId);
        return false;
      }

      // If bot is invited, accept the invite
      if (bridgeBot.membership === 'invite') {
        console.log('[Matrix] Accepting bot invite for WhatsApp room:', roomId);
        await matrixClient.joinRoom(roomId);
        
        // Wait for the join to complete
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Join timeout')), 10000);
          let attempts = 0;
          
          const checkJoin = async () => {
            const updatedRoom = matrixClient.getRoom(roomId);
            const updatedBot = updatedRoom?.currentState.getMember(BRIDGE_CONFIGS.whatsapp.bridgeBot);
            
            if (updatedBot?.membership === 'join') {
              clearTimeout(timeout);
              resolve();
            } else if (attempts > 10) {
              clearTimeout(timeout);
              reject(new Error('Max attempts reached waiting for bot join'));
            } else {
              attempts++;
              setTimeout(checkJoin, 1000);
            }
          };
          
          checkJoin();
        });

        // Update room status in database
        const { error: updateError } = await adminClient
          .from('whatsapp_contacts')
          .update({
            bridge_room_id: roomId,
            sync_status: 'approved',
            updated_at: new Date().toISOString()
          })
          .eq('user_id', userId)
          .eq('metadata->room_id', roomId);

        if (updateError) {
          console.error('[Matrix] Error updating contact after bot join:', updateError);
          throw updateError;
        }

        // Trigger initial sync for the room
        await this.syncMessages(userId, roomId);

        return true;
      }

      return false;
    } catch (error) {
      console.error('[Matrix] Error handling bot invite:', error);
      throw error;
    }
  }

  setMatrixClient = (userId, client) => {
    if (!userId || !client) {
      console.error('[Matrix Service] Invalid parameters for setMatrixClient:', { 
        hasUserId: !!userId, 
        hasClient: !!client 
      });
      return false;
    }
    
    try {
      this.matrixClients.set(userId, client);
      console.log('[Matrix Service] Successfully stored Matrix client for user:', userId);
      return true;
    } catch (error) {
      console.error('[Matrix Service] Error storing Matrix client:', error);
      return false;
    }
  }

  restoreMatrixClient = async (userId, credentials) => {
    try {
      console.log(`[Matrix Service] Restoring Matrix client for user ${userId}`);
      
      // Validate required credentials
      if (!credentials?.homeserver || !credentials?.userId) {
        console.error('[Matrix Service] Missing required Matrix credentials:', {
          hasHomeserver: !!credentials?.homeserver,
          hasAccessToken: !!credentials?.accessToken
        });
        return false;
      }

      // Create Matrix client using SDK
      const client = sdk.createClient({
        baseUrl: credentials.homeserver,
        accessToken: credentials.accessToken,
        userId: credentials.userId
      });

      // Start client and wait for sync
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Matrix sync timeout'));
        }, 30000);

        client.once('sync', (state) => {
          clearTimeout(timeout);
          if (state === 'PREPARED') {
            resolve();
          } else {
            reject(new Error(`Sync failed with state: ${state}`));
          }
        });

        client.startClient({ initialSyncLimit: 10 });
      });
      
      // Check if bot is present in the bridge room
      const botPresent = await this.checkBotPresence(client, credentials.bridge_room_id);
      if (!botPresent) {
        console.log(`[Matrix Service] Bot not found in bridge room for user ${userId}`);
        await client.stopClient();
        return false;
      }

      // Store the client and connection
      this.matrixClients.set(userId, client);
      this.connections.set(userId, {
        client,
        bridgeRoomId: credentials.bridge_room_id,
        status: 'active'
      });

      console.log(`[Matrix Service] Successfully restored connection for user ${userId}`);
      return true;
    } catch (error) {
      console.error(`[Matrix Service] Error restoring Matrix client for user ${userId}:`, error);
      return false;
    }
  }

  getAccount = async (userId) => {
    try {
      console.log("[Matrix Service] Getting accounts for user:", userId);
      
      // Get both WhatsApp and Matrix accounts
      const { data: accounts, error } = await adminClient
        .from('accounts')
        .select('platform, status, credentials')
        .eq('user_id', userId)
        .in('platform', ['whatsapp', 'matrix']);

      if (error) throw error;

      // Find WhatsApp and Matrix accounts
      const whatsappAccount = accounts?.find(acc => acc.platform === 'whatsapp');
      const matrixAccount = accounts?.find(acc => acc.platform === 'matrix');
      
      console.log("[Matrix Service] Found accounts:", {
        hasWhatsApp: !!whatsappAccount,
        hasMatrix: !!matrixAccount,
        whatsappStatus: whatsappAccount?.status,
        hasBridgeRoom: !!whatsappAccount?.credentials?.bridge_room_id
      });

      // Combine credentials for client initialization
      const combinedAccount = whatsappAccount ? {
        ...whatsappAccount,
        credentials: {
          ...whatsappAccount.credentials,
          ...matrixAccount?.credentials
        }
      } : null;
      
      return combinedAccount;
    } catch (error) {
      console.error("[Matrix Service] Error fetching accounts:", error);
      throw error;
    }
  }

  setupTimelineListeners = async (userId, matrixClient) => {
    try {
      console.log('[Matrix Service] Setting up timeline listeners for user:', userId);
      
      // Get all WhatsApp contacts for the user to build room mapping
      const { data: contacts, error: contactError } = await adminClient
        .from('whatsapp_contacts')
        .select('id, whatsapp_id, metadata')
        .eq('user_id', userId);

      if (contactError) throw contactError;

      // Build room to contact mapping
      contacts.forEach(contact => {
        if (contact.metadata?.room_id) {
          this.roomToContactMap.set(contact.metadata.room_id, {
            contactId: contact.id,
            whatsappId: contact.whatsapp_id
          });
        }
      });

      // Set up timeline listener for all rooms
      matrixClient.on('Room.timeline', async (event, room, toStartOfTimeline) => {
        try {
          // Skip if not a message event
          if (event.getType() !== 'm.room.message') return;
          
          // Skip if from bridge bot or self
          if (event.getSender() === BRIDGE_CONFIGS.whatsapp.bridgeBot ||
              event.getSender() === matrixClient.getUserId()) return;

          // Get contact info from room
          const contactInfo = this.roomToContactMap.get(room.roomId);
          if (!contactInfo) {
            console.log('[Matrix Service] No contact mapping found for room:', room.roomId);
            return;
          }

          const content = event.getContent();
          if (!content || !content.body) return;

          // Prepare message data
          const messageData = {
            user_id: userId,
            contact_id: contactInfo.contactId,
            message_id: event.getId(),
            content: content.body,
            sender_id: event.getSender(),
            sender_name: room.getMember(event.getSender())?.name || event.getSender(),
            message_type: content.msgtype === 'm.text' ? 'text' : 'media',
            metadata: {
              room_id: room.roomId,
              event_id: event.getId(),
              raw_event: event.event
            },
            timestamp: new Date(event.getTs()).toISOString(),
            is_read: false
          };

          // Store message in database with retry
          let retryCount = 0;
          while (retryCount < 3) {
            try {
              const { error: insertError } = await adminClient
                .from('whatsapp_messages')
                .upsert(messageData, {
                  onConflict: 'user_id,message_id',
                  returning: true
                });

              if (!insertError) {
                // Update sync status and emit event
                await this.updateSyncStatus(userId, contactInfo.contactId, 'approved');
                global.io?.to(`user:${userId}`).emit('whatsapp:message', messageData);
                break;
              }

              retryCount++;
              if (retryCount < 3) {
                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
              }
            } catch (err) {
              console.error('[Matrix Service] Error storing message (attempt ${retryCount + 1}):', err);
              retryCount++;
              if (retryCount === 3) throw err;
              await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
            }
          }
        } catch (error) {
          console.error('[Matrix Service] Error processing timeline event:', error);
        }
      });

      console.log('[Matrix Service] Timeline listeners setup completed for user:', userId);
    } catch (error) {
      console.error('[Matrix Service] Error setting up timeline listeners:', error);
      throw error;
    }
  }

  getContacts = async (userId) => {
    const CACHE_KEY = `whatsapp:${userId}:contacts`;
    const CACHE_DURATION = 300; // 5 minutes

    try {
      // Check cache first
      const cachedContacts = await pubClient.get(CACHE_KEY);
      if (cachedContacts) {
        const parsed = JSON.parse(cachedContacts);
        // Return cached data if it's less than 5 minutes old
        if (Date.now() - parsed.timestamp < CACHE_DURATION * 1000) {
          return parsed.contacts;
        }
      }

      // Fetch fresh contacts
      const contacts = await this.fetchContactsFromMatrix(userId);
      
      // Cache with metadata
      const contactData = {
        contacts,
        timestamp: Date.now(),
        count: contacts.length
      };

      // Set cache with expiration
      await pubClient.set(
        CACHE_KEY,
        JSON.stringify(contactData),
        'EX',
        CACHE_DURATION
      );

      // Set a secondary index for quick contact count
      await pubClient.set(
        `whatsapp:${userId}:contact_count`,
        contacts.length,
        'EX',
        CACHE_DURATION
      );

      return contacts;
    } catch (error) {
      console.error('Failed to fetch contacts:', error);
      // Return cached data if available, even if expired
      const staleCache = await pubClient.get(CACHE_KEY);
      if (staleCache) {
        return JSON.parse(staleCache).contacts;
      }
      throw error;
    }
  }

  updateContact = async (userId, contactId, updates) => {
    try {
      const result = await this.updateContactInMatrix(userId, contactId, updates);
      
      // Invalidate contact cache
      await pubClient.del(`whatsapp:${userId}:contacts`);
      await pubClient.del(`whatsapp:${userId}:contact_count`);
      
      return result;
    } catch (error) {
      console.error('Failed to update contact:', error);
      throw error;
    }
  }

  // Get bridge room for a user
  getBridgeRoom = async (userId) => {
    try {
      // First check if we have it cached
      if (this.bridgeRooms.has(userId)) {
        return this.bridgeRooms.get(userId);
      }

      // Get the Matrix client
      const matrixClient = this.matrixClients.get(userId);
      if (!matrixClient) {
        throw new Error('Matrix client not initialized');
      }

      // Get user's rooms
      const rooms = matrixClient.getRooms();
      
      // Find the bridge room
      const bridgeRoom = rooms.find(room => {
        const members = room.getJoinedMembers();
        return members.some(member => member.userId === BRIDGE_CONFIGS.whatsapp.bridgeBot) &&
               room.name?.includes('WhatsApp Bridge');
      });

      if (bridgeRoom) {
        // Cache it for future use
        this.bridgeRooms.set(userId, bridgeRoom);
        return bridgeRoom;
      }

      return null;
    } catch (error) {
      console.error('Error getting bridge room:', error);
      return null;
    }
  }

  // Helper method to update sync progress in Redis
  updateSyncProgress = async (syncKey, updates) => {
    try {
      // Get current state with error handling
      let state = {};
      try {
        const currentState = await pubClient.get(syncKey);
        state = currentState ? JSON.parse(currentState) : {};
      } catch (error) {
        console.error('Error parsing sync state:', error);
      }

      // Merge updates with validation
      const newState = {
        ...state,
        ...updates,
        lastUpdated: Date.now()
      };

      // Validate progress is a number between 0-100
      if ('progress' in updates) {
        newState.progress = Math.max(0, Math.min(100, Number(updates.progress) || 0));
      }

      // Special handling for errors array with deduplication
      if (updates.errors) {
        const existingErrors = new Set(state.errors?.map(e => JSON.stringify(e)) || []);
        const newErrors = updates.errors.filter(e => !existingErrors.has(JSON.stringify(e)));
        newState.errors = [...(state.errors || []), ...newErrors];
      }

      // Set TTL based on state
      let ttl = 3600; // Default 1 hour
      if (newState.state === SYNC_STATES.COMPLETED) {
        ttl = 86400; // Keep completed states for 24 hours
      } else if (newState.state === SYNC_STATES.ERROR) {
        ttl = 43200; // Keep error states for 12 hours
      } else if (newState.state === SYNC_STATES.OFFLINE) {
        ttl = 604800; // Keep offline states for 7 days
      }

      // Store updated state with TTL
      await pubClient.set(syncKey, JSON.stringify(newState), 'EX', ttl);

      // Emit state update via socket if connected
      if (updates.state || updates.progress) {
        const [, userId, contactId] = syncKey.split(':');
        const io = getIO();
        const socket = io?.sockets?.adapter?.rooms?.get(`user:${userId}`);
        
        if (socket) {
          io.to(`user:${userId}`).emit('whatsapp:sync_state', {
            contactId,
            ...newState
          });
        } else {
          // Store offline updates for later
          const offlineKey = `offline:${userId}:${contactId}`;
          await pubClient.set(offlineKey, JSON.stringify({
            type: 'sync_state',
            data: newState,
            timestamp: Date.now()
          }), 'EX', 604800); // Store for 7 days
        }
      }

      return newState;
    } catch (error) {
      console.error('Error updating sync progress:', error);
      throw error;
    }
  }

  // New method to handle offline updates when user comes back online
  processOfflineUpdates = async (userId) => {
    try {
      // Get all offline updates for user
      const offlineKeys = await pubClient.keys(`offline:${userId}:*`);
      
      for (const key of offlineKeys) {
        const update = await pubClient.get(key);
        if (update) {
          const { type, data, timestamp } = JSON.parse(update);
          
          // Emit stored update
          global.io?.to(`user:${userId}`).emit(`whatsapp:${type}`, data);
          
          // Clean up processed update
          await pubClient.del(key);
        }
      }
    } catch (error) {
      console.error('Error processing offline updates:', error);
    }
  }

  initializeMatrixClient = async (credentials) => {
    const userId = credentials.userId;
    this.updateConnectionState(userId, CONNECTION_STATES.INITIALIZING);

    try {
      // Validate required credentials
      if (!credentials?.homeserver || !credentials?.userId) {
        throw new Error('Invalid Matrix credentials - missing homeserver or userId');
      }

      // Get valid token using token service
      const tokens = await tokenService.getValidToken();
      if (!tokens?.access_token) {
        throw new Error('No valid token available from token service');
      }

      // Initialize client with enhanced retry logic
      const client = sdk.createClient({
        baseUrl: credentials.homeserver,
        accessToken: tokens.access_token,
        userId: credentials.userId,
        timeoutMs: 60000,
        useAuthorizationHeader: true,
        retryIf: async (attempt, error) => {
          const recovery = await this.handleError(userId, error, {
            attempt,
            method: 'initializeMatrixClient'
          });

          return recovery.shouldRetry;
        }
      });

      // Subscribe to token updates
      const unsubscribe = tokenService.subscribe(async (newTokens) => {
        if (client && newTokens?.access_token) {
          logger.info('[Matrix Client] Updating client with new token');
          client.setAccessToken(newTokens.access_token);
          this.updateConnectionState(userId, CONNECTION_STATES.CONNECTED);
          // Reset auth error count on successful token update
          this.resetErrorCount(userId, ERROR_TYPES.AUTH);
        }
      });

      client._tokenUnsubscribe = unsubscribe;

      this.updateConnectionState(userId, CONNECTION_STATES.CONNECTING);

      // Enhanced sync initialization with error boundaries
      await new Promise((resolve, reject) => {
        const syncTimeout = setTimeout(() => {
          reject(new Error('Matrix sync initialization timeout'));
        }, 30000);

        client.once('sync', async (state, prevState, res) => {
          clearTimeout(syncTimeout);
          if (state === 'PREPARED') {
            resolve();
            // Reset sync error count on successful sync
            this.resetErrorCount(userId, ERROR_TYPES.SYNC);
          } else {
            const error = new Error(`Matrix sync failed: ${state}`);
            const recovery = await this.handleError(userId, error, {
              state,
              prevState,
              method: 'sync'
            });
            reject(error);
          }
        });

        client.startClient({ initialSyncLimit: 20 }).catch(async (error) => {
          const recovery = await this.handleError(userId, error, {
            method: 'startClient'
          });
          reject(error);
        });
      });

      this.startHealthCheck(userId, client);
      this.updateConnectionState(userId, CONNECTION_STATES.CONNECTED);
      return client;
    } catch (error) {
      const recovery = await this.handleError(userId, error, {
        method: 'initializeMatrixClient',
        credentials: {
          ...credentials,
          accessToken: '[REDACTED]'
        }
      });

      this.updateConnectionState(userId, CONNECTION_STATES.ERROR, error);
      throw error;
    }
  }

  validateMatrixToken = async (token) => {
    try {
      // First use token service validation
      if (!tokenService.validateToken(token)) {
        logger.warn('[Matrix Service] Token failed local validation');
        return false;
      }

      // Then verify with Matrix server
      const response = await fetch(`${process.env.MATRIX_HOMESERVER}/_matrix/client/v3/account/whoami`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.status === 200) {
        return true;
      }

      if (response.status === 401) {
        // Token is invalid, try refreshing
        try {
          const newTokens = await tokenService.refreshToken();
          return !!newTokens?.access_token;
        } catch (refreshError) {
          logger.error('[Matrix Service] Token refresh failed:', refreshError);
          return false;
        }
      }

      return false;
    } catch (error) {
      logger.error('[Matrix Service] Token validation error:', error);
      return false;
    }
  }

  getConnectionState = (userId) => {
    return this.connectionStates.get(userId) || {
      state: CONNECTION_STATES.DISCONNECTED,
      health: CONNECTION_HEALTH.UNHEALTHY,
      lastActivity: null,
      error: null
    };
  }

  updateConnectionState = (userId, state, error = null) => {
    const currentState = this.getConnectionState(userId);
    const newState = {
      ...currentState,
      state,
      lastActivity: Date.now(),
      error: error ? { message: error.message, type: getErrorType(error) } : null
    };
    
    this.connectionStates.set(userId, newState);
    
    // Emit state change for monitoring
    ioEmitter.emit('matrix:state_change', {
      userId,
      state: newState
    });

    logger.info('[Matrix Service] Connection state updated:', {
      userId,
      state: newState.state,
      error: newState.error
    });
  }

  checkClientHealth = async (client) => {
    try {
      // Verify client is still connected and syncing
      if (!client || !client.clientRunning || client.getSyncState() !== 'SYNCING') {
        return false;
      }

      // Verify token is still valid
      const tokens = await tokenService.getValidToken();
      if (!tokens?.access_token) {
        return false;
      }

      // Additional health checks
      const whoamiPromise = client.whoami();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Health check timeout')), 5000)
      );
      
      await Promise.race([whoamiPromise, timeoutPromise]);
      return true;
    } catch (error) {
      const userId = client?.credentials?.userId;
      if (userId) {
        await this.handleError(userId, error, {
          method: 'checkClientHealth',
          clientState: client?.getSyncState(),
          lastActivity: this.getConnectionState(userId)?.lastActivity
        });
      }
      return false;
    }
  }

  startHealthCheck = (userId, client) => {
    if (this.healthCheckIntervals.has(userId)) {
      clearInterval(this.healthCheckIntervals.get(userId));
    }

    const interval = setInterval(async () => {
      try {
        const state = this.getConnectionState(userId);
        
        // Skip health check if disconnected
        if (state.state === CONNECTION_STATES.DISCONNECTED) {
          return;
        }

        // Check client health
        const isHealthy = await this.checkClientHealth(client);
        const timeSinceLastActivity = Date.now() - state.lastActivity;
        
        let health = CONNECTION_HEALTH.HEALTHY;
        if (!isHealthy) {
          health = CONNECTION_HEALTH.UNHEALTHY;
        } else if (timeSinceLastActivity > this.HEALTH_CHECK_INTERVAL) {
          health = CONNECTION_HEALTH.DEGRADED;
        }

        // Update state with health status
        const newState = {
          ...state,
          health,
          lastActivity: isHealthy ? Date.now() : state.lastActivity,
          lastHealthCheck: Date.now()
        };
        this.connectionStates.set(userId, newState);

        // Log health status
        logger.info('[Matrix Service] Health check completed:', {
          userId,
          health,
          timeSinceLastActivity,
          syncState: client?.getSyncState()
        });

        // Attempt recovery if unhealthy
        if (health === CONNECTION_HEALTH.UNHEALTHY) {
          await this.attemptRecovery(userId, client);
        }
      } catch (error) {
        await this.handleError(userId, error, {
          method: 'healthCheck',
          lastState: this.getConnectionState(userId)
        });
      }
    }, this.HEALTH_CHECK_INTERVAL);

    this.healthCheckIntervals.set(userId, interval);
  }

  attemptRecovery = async (userId, client) => {
    const attempts = this.reconnectAttempts.get(userId) || 0;
    
    try {
      if (attempts >= this.MAX_RECONNECT_ATTEMPTS) {
        const error = new Error('Max reconnection attempts reached');
        await this.handleError(userId, error, {
          attempts,
          method: 'attemptRecovery'
        });
        this.updateConnectionState(userId, CONNECTION_STATES.ERROR, error);
        return false;
      }

      this.updateConnectionState(userId, CONNECTION_STATES.RECONNECTING);
      this.reconnectAttempts.set(userId, attempts + 1);

      // Log recovery attempt
      logger.info('[Matrix Service] Attempting recovery:', {
        userId,
        attempt: attempts + 1,
        maxAttempts: this.MAX_RECONNECT_ATTEMPTS
      });

      // Stop existing client
      if (client) {
        await client.stopClient();
        // Wait for client to fully stop
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Get stored credentials
      const { data: credentials } = await supabase
        .from('matrix_credentials')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (!credentials) {
        throw new Error('No credentials found for recovery');
      }

      // Initialize new client
      const newClient = await this.initializeMatrixClient(credentials);
      
      // Update stored client reference
      this.matrixClients.set(userId, newClient);
      
      // Reset reconnect attempts on success
      this.reconnectAttempts.set(userId, 0);
      
      // Reset error counts for recovered error types
      this.resetErrorCount(userId, ERROR_TYPES.NETWORK);
      this.resetErrorCount(userId, ERROR_TYPES.SYNC);
      
      this.updateConnectionState(userId, CONNECTION_STATES.CONNECTED);

      // Log successful recovery
      logger.info('[Matrix Service] Recovery successful:', {
        userId,
        attempt: attempts + 1,
        newClientId: newClient.credentials.userId
      });

      return true;
    } catch (error) {
      const recovery = await this.handleError(userId, error, {
        method: 'attemptRecovery',
        attempt: attempts + 1,
        maxAttempts: this.MAX_RECONNECT_ATTEMPTS
      });

      // If we should retry, wait with exponential backoff
      if (recovery.shouldRetry) {
        await new Promise(resolve => setTimeout(resolve, recovery.backoffMs));
        return this.attemptRecovery(userId, client);
      }

      return false;
    }
  }

  cleanup = async (userId) => {
    try {
      // Get connection data
      const connection = this.connections.get(userId);
      if (connection) {
        // Unsubscribe from token updates
        if (connection.tokenUnsubscribe) {
          connection.tokenUnsubscribe();
        }

        // Stop client and remove from memory
        const client = this.matrixClients.get(userId);
        if (client) {
          client.stopClient();
          this.matrixClients.delete(userId);
        }

        // Clear connection data
        this.connections.delete(userId);

        logger.info('[Matrix Service] Cleaned up resources for user:', {
          userId,
          hadClient: !!client,
          hadConnection: true
        });
      }
    } catch (error) {
      logger.error('[Matrix Service] Error during cleanup:', {
        userId,
        error: error.message
      });
    }
  }

  initializeClient = async (userId, credentials) => {
    try {
      // Validate credentials
      if (!credentials?.homeserver || !credentials?.accessToken || !credentials?.userId) {
        throw new Error('Invalid Matrix credentials');
      }

      // Check rate limits for token refresh
      const tokenLimit = await this.tokenLimiter.get({ id: userId });
      if (!tokenLimit.remaining) {
        const retryAfter = Math.ceil((tokenLimit.reset - Date.now()) / 1000);
        throw new Error(`Token refresh rate limit exceeded. Retry after ${retryAfter} seconds`);
      }

      // Create Matrix client
      const client = sdk.createClient({
        baseUrl: credentials.homeserver,
        accessToken: credentials.accessToken,
        userId: credentials.userId,
        timeoutMs: BRIDGE_TIMEOUTS.REQUEST,
        localTimeoutMs: BRIDGE_TIMEOUTS.LOCAL
      });

      // Set up event handlers
      client.on('sync', (state, prevState, data) => {
        this.handleSyncStateChange(userId, state, prevState, data);
      });

      client.on('Room.timeline', (event, room) => {
        this.handleTimelineEvent(userId, event, room);
      });

      // Start client
      await this.startClient(userId, client);

      // Store client in active connections
      this.connectionPool.active.set(userId, {
        client,
        lastUsed: Date.now(),
        syncState: SYNC_STATES.PREPARING
      });

      // Start health check for this client
      this.startHealthCheck(userId, client);

      return client;

    } catch (error) {
      await this.handleError(userId, error, { operation: 'initializeClient' });
      throw error;
    }
  }

  startClient = async (userId, client) => {
    try {
      // Set connection state
      this.connectionStates.set(userId, CONNECTION_STATES.INITIALIZING);

      // Start sync with retry logic
      let syncAttempts = 0;
      const maxSyncAttempts = 3;

      while (syncAttempts < maxSyncAttempts) {
        try {
          // Check sync rate limits
          const syncLimit = await this.syncLimiter.get({ id: userId });
          if (!syncLimit.remaining) {
            const retryAfter = Math.ceil((syncLimit.reset - Date.now()) / 1000);
            throw new Error(`Sync rate limit exceeded. Retry after ${retryAfter} seconds`);
          }

          // Start client sync
          await client.startClient({
            initialSyncLimit: SYNC_BATCH_SIZE,
            includeArchivedRooms: false,
            lazyLoadMembers: true
          });

          // Wait for initial sync
          await this.waitForSync(userId, client);

          // Update connection state
          this.connectionStates.set(userId, CONNECTION_STATES.CONNECTED);
          return true;

        } catch (error) {
          syncAttempts++;
          if (syncAttempts === maxSyncAttempts) {
            throw error;
          }
          await sleep(this.RECONNECT_DELAY * Math.pow(2, syncAttempts));
        }
      }

    } catch (error) {
      this.connectionStates.set(userId, CONNECTION_STATES.ERROR);
      await this.handleError(userId, error, { operation: 'startClient' });
      throw error;
    }
  }

  waitForSync = async (userId, client, timeout = BRIDGE_TIMEOUTS.SYNC) => {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Sync timeout'));
      }, timeout);

      const onSync = (state) => {
        if (state === 'PREPARED' || state === 'SYNCING') {
          cleanup();
          resolve();
        } else if (state === 'ERROR') {
          cleanup();
          reject(new Error('Sync error'));
        }
      };

      const cleanup = () => {
        clearTimeout(timeoutId);
        client.removeListener('sync', onSync);
      };

      client.on('sync', onSync);
    });
  }

  handleSyncStateChange = (userId, state, prevState, data) => {
    try {
      // Update sync state
      this.syncStates.set(userId, state);

      // Log state change
      logger.info('[Matrix Service] Sync state changed:', {
        userId,
        from: prevState,
        to: state,
        data
      });

      // Handle different states
      switch (state) {
        case 'PREPARED':
        case 'SYNCING':
          // Reset error counts on successful sync
          this.errorCounts.delete(userId);
          break;

        case 'ERROR':
          // Handle sync error
          this.handleError(userId, new Error('Sync error'), {
            operation: 'sync',
            prevState,
            data
          });
          break;

        case 'RECONNECTING':
          // Update connection state
          this.connectionStates.set(userId, CONNECTION_STATES.INITIALIZING);
          break;
      }

      // Emit sync state change
      const io = getIO();
      if (io) {
        io.to(userId).emit('matrix:sync_state', {
          userId,
          state,
          timestamp: Date.now()
        });
      }

    } catch (error) {
      logger.error('[Matrix Service] Error handling sync state change:', error);
    }
  }

  startHealthCheck = async (userId, client) => {
    // Clear any existing health check
    if (this.healthCheckIntervals.has(userId)) {
      clearInterval(this.healthCheckIntervals.get(userId));
    }

    // Start new health check interval
    const interval = setInterval(async () => {
      try {
        const health = await this.checkClientHealth(userId, client);
        
        // Log health status
        logger.info('[Matrix Service] Client health check:', {
          userId,
          health
        });

        // Handle unhealthy state
        if (health.status === CONNECTION_HEALTH.UNHEALTHY) {
          await this.handleUnhealthyClient(userId, client, health);
        }

      } catch (error) {
        logger.error('[Matrix Service] Health check failed:', {
          userId,
          error
        });
      }
    }, this.HEALTH_CHECK_INTERVAL);

    this.healthCheckIntervals.set(userId, interval);
  }

  checkClientHealth = async (userId, client) => {
    const health = {
      status: CONNECTION_HEALTH.HEALTHY,
      syncState: this.syncStates.get(userId),
      connectionState: this.connectionStates.get(userId),
      errorCount: this.errorCounts.get(userId),
      lastError: this.lastErrors.get(userId),
      timestamp: Date.now()
    };

    // Check sync state
    if (health.syncState === 'ERROR' || health.syncState === 'RECONNECTING') {
      health.status = CONNECTION_HEALTH.DEGRADED;
    }

    // Check error counts
    const errors = health.errorCount || {};
    if (errors[ERROR_TYPES.AUTH] > this.errorThresholds.AUTH ||
        errors[ERROR_TYPES.SYNC] > this.errorThresholds.SYNC) {
      health.status = CONNECTION_HEALTH.UNHEALTHY;
    }

    // Check connection state
    if (health.connectionState === CONNECTION_STATES.ERROR) {
      health.status = CONNECTION_HEALTH.UNHEALTHY;
    }

    return health;
  }

  handleUnhealthyClient = async (userId, client, health) => {
    try {
      logger.warn('[Matrix Service] Unhealthy client detected:', {
        userId,
        health
      });

      // Increment reconnect attempts
      const attempts = (this.reconnectAttempts.get(userId) || 0) + 1;
      this.reconnectAttempts.set(userId, attempts);

      if (attempts > this.MAX_RECONNECT_ATTEMPTS) {
        logger.error('[Matrix Service] Max reconnect attempts reached:', {
          userId,
          attempts
        });
        
        // Move to idle pool
        await this.moveToIdlePool(userId);
        return;
      }

      // Attempt recovery
      await this.attemptRecovery(userId, client);

    } catch (error) {
      logger.error('[Matrix Service] Error handling unhealthy client:', {
        userId,
        error
      });
    }
  }

  attemptRecovery = async (userId, client) => {
    try {
      logger.info('[Matrix Service] Attempting client recovery:', { userId });

      // Stop client
      client.stopClient();

      // Clear existing state
      this.syncStates.delete(userId);
      this.connectionStates.set(userId, CONNECTION_STATES.INITIALIZING);

      // Attempt to restart client
      await this.startClient(userId, client);

      // Reset reconnect attempts on success
      this.reconnectAttempts.delete(userId);

      logger.info('[Matrix Service] Client recovery successful:', { userId });

    } catch (error) {
      logger.error('[Matrix Service] Recovery attempt failed:', {
        userId,
        error
      });
      throw error;
    }
  }
}

// Create service instance
const matrixWhatsAppService = new MatrixWhatsAppService();

// Add cleanup on process exit
process.on('SIGTERM', async () => {
  logger.info('[Matrix Service] Starting cleanup on SIGTERM');
  const cleanupPromises = Array.from(matrixWhatsAppService.connections.keys()).map(userId => 
    matrixWhatsAppService.cleanup(userId)
  );
  await Promise.allSettled(cleanupPromises);
  logger.info('[Matrix Service] Cleanup complete');
});

export { matrixWhatsAppService }; 