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

class MatrixWhatsAppService {
  constructor() {
    this.connections = new Map();
    this.matrixClients = new Map();
    this.syncStates = new Map();
    this.messageHandlers = new Map();
    this.roomToContactMap = new Map();
  }

  async validateMatrixClient(userId) {
    const client = this.matrixClients.get(userId);
    if (!client) {
      throw new Error('Matrix client not initialized');
    }

    const MAX_RETRIES = 3;
    const RETRY_DELAY = 2000;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`Retrying Matrix client validation (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt));
        }

        // Try whoami with timeout
        const whoamiPromise = client.whoami();
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('whoami timeout')), 10000)
        );
        
        const whoamiResponse = await Promise.race([whoamiPromise, timeoutPromise]);
        console.log('Matrix client validation successful:', whoamiResponse);
      return true;
    } catch (error) {
        console.error(`Matrix client validation attempt ${attempt + 1} failed:`, error);
        if (attempt === MAX_RETRIES - 1) {
          throw error;
        }
      }
    }
    return false;
  }

  async initialize({ userId, credentials, authToken }) {
    try {
      console.log('=== Starting Matrix Initialization ===');
      console.log('Step 1: Validating input parameters:', {
        userId,
        matrixUserId: credentials?.userId,
        hasAuthToken: !!authToken
      });

      if (!userId || !credentials || !authToken) {
        throw new Error('Missing required parameters for Matrix initialization');
      }

      // Validate credentials format first
      console.log('Step 2: Validating credentials format');
      const credentialsValidation = validateCredentialsFormat(credentials);
      if (!credentialsValidation.valid) {
        throw new Error(credentialsValidation.error);
      }

      // Get current onboarding status
      console.log('Step 3: Checking onboarding status');
      const { data: onboardingStatus, error: statusError } = await adminClient
        .from('user_onboarding')
        .select('current_step')
        .eq('user_id', userId)
        .single();

      if (statusError) {
        console.error('Failed to fetch onboarding status:', statusError);
        throw new Error('Failed to verify onboarding status');
      }

      if (onboardingStatus?.current_step !== 'matrix_setup') {
        console.error('Invalid onboarding state:', onboardingStatus?.current_step);
        throw new Error('Matrix initialization not allowed in current onboarding state');
      }

      // Initialize Matrix client
      console.log('Step 4: Creating Matrix client instance');
      const matrixClient = sdk.createClient({
        baseUrl: credentials.homeserver,
        userId: credentials.userId,
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

      // Try login with retries
      console.log('Step 5: Attempting Matrix login');
      let loginResponse;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt > 0) {
            console.log(`Retrying Matrix login (attempt ${attempt + 1}/3)`);
            await new Promise(resolve => setTimeout(resolve, attempt * 2000));
          }
          
          loginResponse = await matrixClient.login('m.login.password', {
            user: credentials.userId,
            password: credentials.password,
            initial_device_display_name: 'DailyFix App'
          });
          
          console.log('Matrix login successful');
          break;
        } catch (error) {
          console.error(`Login attempt ${attempt + 1} failed:`, error);
          if (attempt === 2) throw error;
        }
      }

      if (!loginResponse) {
        throw new Error('Failed to login to Matrix after all attempts');
      }

      // Update account in database
      console.log('Step 6: Updating account in database');
      const accountData = {
        user_id: userId,
        platform: 'matrix',
        status: 'active',
        credentials: {
          userId: credentials.userId,
          homeserver: credentials.homeserver,
          accessToken: loginResponse.access_token
        },
        connected_at: new Date().toISOString()
      };

      const { error: upsertError } = await adminClient
          .from('accounts')
        .upsert(accountData, {
          onConflict: 'user_id,platform',
          returning: 'minimal'
        });

      if (upsertError) {
        console.error('Database operation error:', upsertError);
        throw new Error(`Failed to update Matrix account: ${upsertError.message}`);
      }

      // Store client in memory
      console.log('Step 7: Storing Matrix client in memory for user:', userId);
      this.matrixClients.set(userId, matrixClient);

      // Verify client was stored
      const storedClient = this.matrixClients.get(userId);
      if (!storedClient) {
        throw new Error('Failed to store Matrix client in memory');
      }
      console.log('Matrix client successfully stored in memory');

      // Update onboarding status to next step
      console.log('Step 8: Updating onboarding status to WhatsApp setup');
      const { error: updateError } = await adminClient
        .from('user_onboarding')
        .update({
          current_step: 'whatsapp_setup',
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId);

      if (updateError) {
        console.error('Failed to update onboarding status:', updateError);
        throw new Error('Failed to progress to WhatsApp setup');
      }

      console.log('=== Matrix Initialization Completed Successfully ===');
      return {
        status: 'active',
        message: 'Matrix client initialized successfully',
        nextStep: 'whatsapp_setup'
      };
    } catch (error) {
      console.error('=== Matrix Initialization Failed ===');
      console.error('Error details:', {
        message: error.message,
        stack: error.stack,
        userId,
        matrixUserId: credentials?.userId
      });
      throw error;
    }
  }

  async updateConnectionStatus(userId, status, bridgeRoomId = null) {
    try {
      // Update account status
      const { error: accountError } = await adminClient
        .from('accounts')
        .upsert({
          user_id: userId,
          platform: 'whatsapp',
          status: status,
          platform_user_id: bridgeRoomId || null,
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'user_id,platform',
          returning: true
        });

      if (accountError) throw accountError;

      // Emit status update event
      const io = getIO();
      io.to(`user:${userId}`).emit('whatsapp:status_update', {
        status,
        bridgeRoomId
      });

      return true;
    } catch (error) {
      console.error('Error updating WhatsApp connection status:', error);
      throw error;
    }
  }

  async connectWhatsApp(userId) {
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

  async disconnectWhatsApp(userId) {
    try {
      const connection = this.connections.get(userId);
      if (!connection) {
        throw new Error('No active WhatsApp connection found');
      }

      await this.updateConnectionStatus(userId, 'disconnecting');

      const { matrixClient, bridgeRoomId } = connection;

      // Send logout command
      await matrixClient.sendMessage(bridgeRoomId, {
        msgtype: 'm.text',
        body: BRIDGE_CONFIGS.whatsapp.logoutCommand
      });

      // Update account status
      await supabase
        .from('accounts')
        .update({
          status: 'inactive',
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('platform', 'whatsapp');

      this.connections.delete(userId);

      await this.updateConnectionStatus(userId, 'disconnected');
      return true;
    } catch (error) {
      await this.updateConnectionStatus(userId, 'error');
      console.error('Error disconnecting WhatsApp:', error);
      throw error;
    }
  }

  async getStatus(userId) {
    try {
      // Check in-memory connection first
      const connection = this.connections.get(userId);
      
      // Get database status
      const { data: account } = await adminClient
        .from('accounts')
        .select('status, credentials')
        .eq('user_id', userId)
        .eq('platform', 'whatsapp')
        .single();

      // If we have an in-memory connection but no database record, something is wrong
      if (connection && !account) {
        console.warn('Found in-memory connection but no database record');
        this.connections.delete(userId); // Clean up inconsistent state
        return {
          status: 'inactive',
          message: 'WhatsApp connection state is inconsistent'
        };
      }

      // If we have a database record but no in-memory connection, try to restore it
      if (account?.status === 'connected' && !connection) {
        console.warn('Found active database connection but no in-memory state');
        const matrixClient = this.matrixClients.get(userId);
        if (matrixClient && account.credentials?.bridge_room_id) {
          // Verify the bridge room still exists and is accessible
          try {
            const room = matrixClient.getRoom(account.credentials.bridge_room_id);
            if (room) {
              // Check if bridge bot is still in the room
              const bridgeBot = room.getMember(BRIDGE_CONFIGS.whatsapp.bridgeBot);
              if (bridgeBot && bridgeBot.membership === 'join') {
                // Store connection with full credentials
                this.connections.set(userId, {
                  matrixClient,
                  bridgeRoomId: account.credentials.bridge_room_id,
                  status: 'connected',
                  credentials: account.credentials // Store full credentials
                });
                console.log('Successfully restored WhatsApp connection state with credentials');
              } else {
                console.warn('Bridge bot not found in room, marking as inactive');
                await this.updateConnectionStatus(userId, 'inactive');
                account.status = 'inactive';
              }
            } else {
              console.warn('Bridge room not found, marking as inactive');
              await this.updateConnectionStatus(userId, 'inactive');
              account.status = 'inactive';
            }
          } catch (error) {
            console.error('Error verifying bridge room:', error);
            await this.updateConnectionStatus(userId, 'inactive');
            account.status = 'inactive';
          }
        }
      }

      if (!account) {
        return {
          status: 'inactive',
          message: 'No WhatsApp account found'
        };
      }

      // Verify in-memory connection matches database state
      if (connection && account.status === 'connected') {
        try {
          const room = connection.matrixClient.getRoom(connection.bridgeRoomId);
          if (!room) {
            console.warn('Bridge room not found for active connection');
            this.connections.delete(userId);
            await this.updateConnectionStatus(userId, 'inactive');
            account.status = 'inactive';
          }
        } catch (error) {
          console.error('Error verifying connection:', error);
          this.connections.delete(userId);
          await this.updateConnectionStatus(userId, 'inactive');
          account.status = 'inactive';
        }
      }

      return {
        status: account.status,
        message: `WhatsApp connection is ${account.status}`,
        bridgeRoomId: account.credentials?.bridge_room_id,
        inMemoryConnection: !!this.connections.get(userId)
      };
    } catch (error) {
      console.error('WhatsApp status check error:', error);
      throw error;
    }
  }

  async setupMessageSync(userId, matrixClient) {
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
            console.log('No contact mapping found for room:', room.roomId);
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

          // Store message in database
          const { error: insertError } = await adminClient
            .from('whatsapp_messages')
            .upsert(messageData, {
              onConflict: 'user_id,message_id',
              returning: true
            });

          if (insertError) {
            console.error('Error storing message:', insertError);
            return;
          }

          // Update sync status if needed
          await this.updateSyncStatus(userId, contactInfo.contactId, 'approved');

          // Emit real-time update
          global.io?.to(`user:${userId}`).emit('whatsapp:message', messageData);

        } catch (error) {
          console.error('Error processing timeline event:', error);
        }
      });

      // Set up reconnection handler
      matrixClient.on('sync', async (state, prevState, data) => {
        console.log('Matrix sync state changed:', state, 'from:', prevState);
        
        if (state === 'ERROR') {
          console.error('Matrix sync error:', data);
          // Attempt to reconnect
          setTimeout(() => {
            console.log('Attempting to reconnect Matrix client...');
            matrixClient.startClient().catch(err => 
              console.error('Reconnection failed:', err)
            );
          }, 5000);
        }
      });

      console.log('Message sync setup completed for user:', userId);
      return true;
    } catch (error) {
      console.error('Error setting up message sync:', error);
      throw error;
    }
  }

  async syncMessages(userId, contactId) {
    try {
      console.log('Starting message sync for user:', userId, 'contact:', contactId);

      // Get current status and attempt to restore connection if needed
      const status = await this.getStatus(userId);
      console.log('Current WhatsApp status:', status);

      // Validate connection
      let connection = this.connections.get(userId);
      if (!connection) {
        if (status.status === 'connected' || status.status === 'active') {
          console.log('Attempting to restore WhatsApp connection...');
          
          // Get Matrix client
          const matrixClient = this.matrixClients.get(userId);
          if (!matrixClient) {
            throw new Error('Matrix client not initialized');
          }

          // Get account details
          const { data: account } = await adminClient
            .from('accounts')
            .select('credentials')
            .eq('user_id', userId)
            .eq('platform', 'whatsapp')
            .single();

          if (!account?.credentials?.bridge_room_id) {
            throw new Error('Invalid WhatsApp account configuration');
          }

          // Verify bridge room
          const room = matrixClient.getRoom(account.credentials.bridge_room_id);
          if (!room) {
            throw new Error('Bridge room not found');
          }

          // Store connection
          this.connections.set(userId, {
            matrixClient,
            bridgeRoomId: account.credentials.bridge_room_id,
            status: 'connected',
            credentials: account.credentials
          });

          connection = this.connections.get(userId);
          console.log('WhatsApp connection restored successfully');
        }

        if (!connection) {
          throw new Error('No active WhatsApp connection found');
        }
      }

      // Validate Matrix client
      const matrixClient = this.matrixClients.get(userId);
      if (!matrixClient) {
        throw new Error('Matrix client not initialized');
      }

      // Get contact details
      const { data: contact, error: contactError } = await adminClient
        .from('whatsapp_contacts')
        .select('whatsapp_id, metadata')
        .eq('id', contactId)
        .eq('user_id', userId)
        .single();

      if (contactError || !contact) {
        throw new Error('Contact not found');
      }

      // Ensure message sync is set up
      if (!this.messageHandlers.has(userId)) {
        await this.setupMessageSync(userId, matrixClient);
      }

      // Update room mapping if needed
      if (contact.metadata?.room_id) {
        this.roomToContactMap.set(contact.metadata.room_id, {
          contactId: contactId,
          whatsappId: contact.whatsapp_id
        });
      }

      // Create or update sync request
      const { error: syncError } = await adminClient
        .from('whatsapp_sync_requests')
        .upsert({
          user_id: userId,
          contact_id: contactId,
          status: 'pending',
          requested_at: new Date().toISOString()
        }, {
          onConflict: 'user_id,contact_id'
        });

      if (syncError) throw syncError;

      // Get room and ensure timeline is initialized
      const room = matrixClient.getRoom(contact.metadata.room_id);
      if (!room) {
        throw new Error('Room not found');
      }

      // Wait for timeline to be ready
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeline initialization timeout'));
        }, 10000);

        const checkTimeline = () => {
          if (room.timeline && room.timeline.length > 0) {
            clearTimeout(timeout);
            resolve();
          } else {
            // Request a small initial sync to initialize timeline
            matrixClient.createMessagesRequest(
              contact.metadata.room_id,
              null,
              20,
              'm.room.message'
            ).then(() => {
              setTimeout(checkTimeline, 500);
            }).catch(error => {
              clearTimeout(timeout);
              reject(error);
            });
          }
        };

        checkTimeline();
      });

      // Now that timeline is initialized, request scrollback
      await matrixClient.scrollback(room, 50);

      return {
        status: 'syncing',
        message: 'Message synchronization initiated'
      };

    } catch (error) {
      console.error('Message sync error:', error);
      this.syncStates.delete(userId);
      throw error;
    }
  }

  getMatrixClient(userId) {
    return this.matrixClients.get(userId);
  }

  async updateSyncStatus(userId, contactId, status) {
    try {
      const { error: updateError } = await adminClient
        .from('whatsapp_sync_requests')
        .update({ status })
        .eq('user_id', userId)
        .eq('contact_id', contactId);

      if (updateError) throw updateError;
    } catch (err) {
      console.error('Error updating sync status:', err);
    }
  }

  async handleMessage(userId, event) {
    try {
      const roomId = event.getRoomId();
      const contactInfo = this.roomToContactMap.get(roomId);
  
      if (!contactInfo) {
        console.log('No contact mapping found for room:', roomId);
        return;
      }
  
      const content = event.getContent();
      if (!content || !content.body) return;
  
      // Determine the message type
      let messageType;
      switch (content.msgtype) {
        case 'm.image':
          messageType = 'image';
          break;
        case 'm.video':
          messageType = 'video';
          break;
        case 'm.audio':
          messageType = 'audio';
          break;
        case 'm.file':
          const fileName = (content.body || '').toLowerCase();
          const mimeType = (content.info?.mimetype || '').toLowerCase();
  
          if (mimeType.startsWith('video/') || fileName.match(/\.(mp4|mov|avi|mkv)$/)) {
            messageType = 'video';
          } else if (mimeType.startsWith('audio/') || fileName.match(/\.(mp3|wav|ogg|m4a)$/)) {
            messageType = 'audio';
          } else if (mimeType.startsWith('image/') || fileName.match(/\.(jpg|jpeg|png|gif|webp)$/)) {
            messageType = 'image';
          } else {
            messageType = 'document';
          }
          break;
        case 'm.text':
        default:
          messageType = 'text';
      }
  
      // Ensure messageType is valid
      const ALLOWED_TYPES = ['text', 'image', 'video', 'audio', 'document'];
      if (!ALLOWED_TYPES.includes(messageType)) {
        console.warn(`Invalid message type "${messageType}" detected, defaulting to "text"`);
        messageType = 'text';
      }
  
      // Prepare message data
      const messageData = {
        user_id: userId,
        contact_id: contactInfo.contactId,
        message_id: event.getId(),
        content: content.body || '',
        sender_id: event.getSender(),
        sender_name: event.sender?.name || event.getSender(),
        message_type: messageType,
        metadata: {
          room_id: roomId,
          event_type: event.getType(),
          content: content
        },
        timestamp: new Date(event.getTs()).toISOString(),
        is_read: false
      };
  
      console.log('Final message data:', messageData);
  
      // Store the message in the database
      const { error: insertError } = await adminClient
        .from('whatsapp_messages')
        .insert(messageData);
  
      if (insertError) {
        console.error('Error storing message:', insertError);
        throw insertError;
      }
  
      // Update sync status
      await this.updateSyncStatus(userId, contactInfo.contactId, 'completed');
    } catch (error) {
      console.error('Error processing timeline event:', error);
      if (contactInfo) {
        await this.updateSyncStatus(userId, contactInfo.contactId, 'error');
      }
    }
  }
  
}

export const matrixWhatsAppService = new MatrixWhatsAppService(); 