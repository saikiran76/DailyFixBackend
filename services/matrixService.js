import sdk from 'matrix-js-sdk';
import { adminClient } from '../utils/supabase.js';
import { matrixRoomService } from './matrixRoomService.js';

export const initializeMatrixClient = async (credentials) => {
  let client = null;
  let authenticatedClient = null;
  const MAX_DNS_RETRIES = 3;
  const DNS_RETRY_DELAY = 2000;

  try {
    console.log('Initializing Matrix client with credentials:', {
      homeserver: credentials.homeserver,
      username: credentials.username
    });

    // Create initial client for login with direct server URL
    const baseUrl = credentials.homeserver || process.env.MATRIX_HOMESERVER_URL;

    // Try to resolve DNS first
    for (let attempt = 0; attempt < MAX_DNS_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`DNS resolution attempt ${attempt + 1}/${MAX_DNS_RETRIES}`);
          await new Promise(resolve => setTimeout(resolve, DNS_RETRY_DELAY * attempt));
        }

        // Test connection to homeserver
        const response = await fetch(`${baseUrl}/_matrix/client/versions`);
        if (!response.ok) {
          throw new Error(`Server returned ${response.status}`);
        }
        break;
      } catch (error) {
        console.error(`DNS resolution attempt ${attempt + 1} failed:`, error);
        if (attempt === MAX_DNS_RETRIES - 1) throw error;
      }
    }

    client = sdk.createClient({
      baseUrl,
      timeoutMs: 20000,
      retryIf: (attempt, error) => {
        console.log(`Matrix client retry attempt ${attempt}:`, error.message);
        return attempt < 3 && (
          error.name === 'ConnectionError' ||
          error.errcode === 'M_LIMIT_EXCEEDED' ||
          error.name === 'TimeoutError'
        );
      },
      validateCertificate: false,
      useAuthorizationHeader: true,
      apiVersion: "v1.6"
    });

    // Attempt Matrix login with full user ID
    const loginResponse = await client.login('m.login.password', {
      identifier: {
        type: 'm.id.user',
        // Ensure username has server suffix if not present
        user: credentials.username.includes(':') ? 
          credentials.username : 
          `${credentials.username}:13.48.71.200`
      },
      password: credentials.password,
      initial_device_display_name: 'CMS Matrix Bridge'
    });

    if (!loginResponse?.access_token) {
      throw new Error('Invalid login response - no access token received');
    }

    // Create authenticated client with the access token
    authenticatedClient = sdk.createClient({
      baseUrl,
      accessToken: loginResponse.access_token,
      userId: loginResponse.user_id,
      deviceId: loginResponse.device_id,
      validateCertificate: false,
      useAuthorizationHeader: true,
      apiVersion: "v1.6"
    });

    // Start the client to enable sync and push rules
    await authenticatedClient.startClient({
      initialSyncLimit: 10,
      includeArchivedRooms: false
    });

    // Wait for initial sync
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Initial sync timed out'));
      }, 30000);

      authenticatedClient.once('sync', (state) => {
        if (state === 'PREPARED') {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    // Set up room invite handler
    await matrixRoomService.setupSyncHandler(loginResponse.user_id, authenticatedClient);

    console.log('Matrix client initialized successfully for user:', loginResponse.user_id);

    return authenticatedClient;
  } catch (error) {
    console.error('Error initializing Matrix client:', error);
    
    // Clean up clients if initialization failed
    if (authenticatedClient) {
      try {
        await authenticatedClient.stopClient();
      } catch (cleanupError) {
        console.error('Error cleaning up authenticated client:', cleanupError);
      }
    }
    
    if (client) {
      try {
        await client.logout();
      } catch (cleanupError) {
        console.error('Error cleaning up login client:', cleanupError);
      }
    }

    // Preserve original Matrix error codes
    if (error.errcode) {
      throw error;
    }
    
    throw new Error(error.message || 'Failed to initialize Matrix client');
  }
};

export const getMatrixClient = async (userId) => {
  try {
    // Get Matrix credentials from database
    const { data: account, error } = await adminClient
      .from('accounts')
      .select('credentials')
      .eq('user_id', userId)
      .eq('platform', 'matrix')
      .eq('status', 'active')
      .single();

    if (error || !account?.credentials) {
      throw new Error('No active Matrix account found');
    }

    const { credentials } = account;

    // Create authenticated client with the custom homeserver
    const client = sdk.createClient({
      baseUrl: process.env.MATRIX_HOMESERVER_URL,
      accessToken: credentials.access_token,
      userId: credentials.user_id,
      useAuthorizationHeader: true,
      apiVersion: "v1.6"
    });

    // Start the client
    await client.startClient({
      initialSyncLimit: 10,
      includeArchivedRooms: false
    });

    return client;
  } catch (error) {
    console.error('Error getting Matrix client:', error);
    throw error;
  }
};

export const createMatrixRoom = async (userId, platform, roomName) => {
  try {
    console.log('Creating Matrix room:', { userId, platform, roomName });
    
    // Get the Matrix client for the user
    const matrixClient = await getMatrixClient(userId);

    // Create the room
    const { room_id } = await matrixClient.createRoom({
      visibility: 'private',
      name: roomName,
      topic: `Bridge room for ${platform}`,
      preset: 'private_chat',
      initial_state: [{
        type: 'm.room.guest_access',
        state_key: '',
        content: {
          guest_access: 'forbidden'
        }
      }]
    });

    console.log('Matrix room created successfully:', room_id);

    return {
      roomId: room_id,
      name: roomName
    };
  } catch (error) {
    console.error('Error creating Matrix room:', error);
    throw error;
  }
};

export const getMatrixRooms = async (userId) => {
  try {
    console.log('Getting Matrix rooms for user:', userId);
    
    // Get the Matrix client for the user
    const matrixClient = await getMatrixClient(userId);

    // Wait for initial sync to complete
    await new Promise((resolve) => {
      const checkSync = () => {
        if (matrixClient.isInitialSyncComplete()) {
          resolve();
        } else {
          setTimeout(checkSync, 500);
        }
      };
      checkSync();
    });

    // Get all rooms
    const rooms = matrixClient.getRooms();
    
    // Map rooms to a simplified format
    const mappedRooms = rooms.map(room => ({
      id: room.roomId,
      name: room.name,
      topic: room.currentState.getStateEvents('m.room.topic', '')[0]?.getContent().topic,
      members: room.getJoinedMemberCount(),
      lastMessage: room.timeline[room.timeline.length - 1]?.getContent().body,
      lastMessageTimestamp: room.timeline[room.timeline.length - 1]?.getTs(),
      bridgeInfo: room.currentState.getStateEvents('bridge.info', '')[0]?.getContent()
    }));

    console.log(`Found ${mappedRooms.length} rooms for user ${userId}`);
    
    return mappedRooms;
  } catch (error) {
    console.error('Error getting Matrix rooms:', error);
    throw error;
  }
};

export const sendMatrixMessage = async (userId, roomId, content) => {
  try {
    console.log('Sending Matrix message:', { userId, roomId });
    
    // Get the Matrix client for the user
    const matrixClient = await getMatrixClient(userId);

    // Send the message
    const result = await matrixClient.sendMessage(roomId, {
      msgtype: 'm.text',
      body: content
    });

    console.log('Matrix message sent successfully:', result.event_id);
    
    return {
      messageId: result.event_id,
      timestamp: Date.now()
    };
  } catch (error) {
    console.error('Error sending Matrix message:', error);
    throw error;
  }
};

export const getMatrixMessages = async (userId, roomId, limit = 50) => {
  try {
    console.log('Getting Matrix messages:', { userId, roomId, limit });
    
    // Get the Matrix client for the user
    const matrixClient = await getMatrixClient(userId);

    // Wait for initial sync to complete
    await new Promise((resolve) => {
      const checkSync = () => {
        if (matrixClient.isInitialSyncComplete()) {
          resolve();
        } else {
          setTimeout(checkSync, 500);
        }
      };
      checkSync();
    });

    // Get the room
    const room = matrixClient.getRoom(roomId);
    if (!room) {
      throw new Error(`Room ${roomId} not found`);
    }

    // Get timeline events
    const timeline = room.timeline;
    const messages = timeline
      .filter(event => event.getType() === 'm.room.message')
      .slice(-limit)
      .map(event => ({
        id: event.getId(),
        content: event.getContent().body,
        sender: event.getSender(),
        timestamp: event.getTs(),
        type: event.getContent().msgtype
      }));

    console.log(`Found ${messages.length} messages in room ${roomId}`);
    
    return messages;
  } catch (error) {
    console.error('Error getting Matrix messages:', error);
    throw error;
  }
};