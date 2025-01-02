import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode';
import { adminClient } from '../utils/supabase.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import sdk from 'matrix-js-sdk';
import { ioEmitter } from '../utils/emitter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sessions = new Map();

// Update bot ID to match the mautrix-whatsapp bridge bot
const WHATSAPP_BOT_USERID = process.env.WHATSAPP_BOT_USERID || '@whatsappbot:example-mtbr.duckdns.org';
const MATRIX_HOMESERVER = process.env.MATRIX_HOMESERVER_URL || 'http://13.48.71.200:8008';

// Helper function to emit WhatsApp status updates

const emitWhatsAppStatus = (userId, status, data = {}) => {
  ioEmitter.emit('whatsapp_status', {
    userId,
    status,
    ...data
  });
};

// Helper function to check if a room allows federation
const checkRoomFederation = async (matrixClient, room) => {
  try {
    const joinRules = room.currentState.getStateEvents('m.room.join_rules', '');
    const guestAccess = room.currentState.getStateEvents('m.room.guest_access', '');
    
    console.log('Room federation settings:', {
      joinRules: joinRules?.getContent(),
      guestAccess: guestAccess?.getContent()
    });
    
    return true;
  } catch (error) {
    console.warn('Error checking room federation:', error);
    return false;
  }
};

// Helper function to wait for bot to join room with exponential backoff
const waitForBotJoin = async (matrixClient, roomId, maxAttempts = 6) => {
  console.log(`Waiting for bot ${WHATSAPP_BOT_USERID} to join room ${roomId}...`);
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`Attempt ${attempt}/${maxAttempts}`);
    
    const room = matrixClient.getRoom(roomId);
    if (room) {
      const members = room.getJoinedMembers();
      console.log(`Room has ${members.length} members:`, members.map(m => m.userId));
      
      if (members.some(member => member.userId === WHATSAPP_BOT_USERID)) {
        console.log('Bot has joined the room');
        return true;
      }
    }
    
    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
    console.log(`Bot not joined yet, waiting ${delay}ms before next attempt...`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  
  throw new Error('Timeout waiting for WhatsApp bot to join room');
};

// Helper function to verify bot presence and permissions
const verifyBotInRoom = async (matrixClient, room) => {
  console.log(`Verifying bot presence in room ${room.roomId}...`);
  
  try {
    // Wait for bot to join with improved error handling
    const botJoined = await waitForBotJoin(matrixClient, room.roomId);
    if (!botJoined) {
      throw new Error(`WhatsApp bridge bot ${WHATSAPP_BOT_USERID} failed to join room`);
    }

    // Check room power levels
    const powerLevels = room.currentState.getStateEvents('m.room.power_levels', '');
    console.log('Room power levels:', powerLevels?.getContent());

    // Check recent events
    console.log('Bot found in room, checking recent events...');
    const events = room.timeline.filter(event => 
      event.getSender() === WHATSAPP_BOT_USERID && 
      event.getType() === 'm.room.message'
    ).slice(-5);

    console.log('Recent bot events:', events.map(e => ({
      type: e.getType(),
      content: e.getContent(),
      timestamp: new Date(e.getTs()).toISOString()
    })));

    return true;
  } catch (error) {
    console.error('Error verifying bot in room:', error);
    throw error;
  }
};

// Helper function to wait for bot response
const waitForBotResponse = async (matrixClient, room, userId, maxAttempts = 30) => {
  console.log(`Waiting for bot response in room ${room.roomId}...`);
  let attempts = 0;

  while (attempts < maxAttempts) {
    const events = room.timeline
      .filter(event => event.getSender() === WHATSAPP_BOT_USERID)
      .slice(-5);

    for (const event of events) {
      const content = event.getContent();
      console.log('Processing bot event:', {
        type: event.getType(),
        msgtype: content.msgtype,
        body: content.body,
        timestamp: new Date(event.getTs()).toISOString()
      });

      if (content.msgtype === 'm.image') {
        console.log('Found QR code image from bot');
        emitWhatsAppStatus(userId, 'pending', { qrCode: content.url });
        return { type: 'qr_code', data: content.url };
      }

      if (content.msgtype === 'm.text') {
        if (content.body?.includes('successfully logged in')) {
          console.log('Found successful login message');
          emitWhatsAppStatus(userId, 'connected');
          return { type: 'success' };
        }
        if (content.body?.includes('error') || content.body?.includes('failed')) {
          console.log('Found error message:', content.body);
          emitWhatsAppStatus(userId, 'error', { error: content.body });
          return { type: 'error', message: content.body };
        }
      }
    }

    console.log(`No relevant bot response found, attempt ${attempts + 1}/${maxAttempts}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    attempts++;
  }

  throw new Error('Timed out waiting for bot response');
};

// Helper function to find or create DM with bot
const findOrCreateBotDM = async (matrixClient) => {
  console.log('Looking for direct message with WhatsApp bot...');
  
  // First, check if we already have a DM with the bot
  const rooms = matrixClient.getRooms();
  console.log('Checking existing rooms:', rooms.map(r => ({
    roomId: r.roomId,
    isDM: r.isDirect,
    members: r.getJoinedMembers().map(m => m.userId)
  })));

  // Look for an existing DM
  let dmRoom = rooms.find(room => {
    const members = room.getJoinedMembers();
    const memberIds = members.map(m => m.userId);
    return memberIds.includes(WHATSAPP_BOT_USERID) && members.length === 2;
  });

  if (!dmRoom) {
    console.log('No existing DM found with bot, creating new one...');
    try {
      // Create a new DM with the bot
      const { room_id } = await matrixClient.createRoom({
        is_direct: true,
        invite: [WHATSAPP_BOT_USERID],
        visibility: 'private',
        preset: 'trusted_private_chat',
        initial_state: [{
          type: 'm.room.encryption',
          state_key: '',
          content: {
            algorithm: 'm.megolm.v1.aes-sha2'
          }
        }]
      });

      // Wait for the room to be available in the client state
      await new Promise(resolve => setTimeout(resolve, 2000));
      dmRoom = matrixClient.getRoom(room_id);
      
      if (!dmRoom) {
        throw new Error('Failed to create DM with WhatsApp bot');
      }
    } catch (error) {
      console.error('Error creating DM with bot:', error);
      throw new Error('Failed to establish direct message with WhatsApp bot');
    }
  }

  return dmRoom;
};

// Helper function to find direct message room with WhatsApp bot
const findDirectMessageRoom = async (matrixClient) => {
  console.log('Looking for DM room with WhatsApp bot:', WHATSAPP_BOT_USERID);
  
  try {
    const rooms = matrixClient.getRooms();
    console.log(`Found ${rooms.length} total rooms`);
    
    for (const room of rooms) {
      const members = room.getJoinedMembers();
      console.log(`Room ${room.roomId} has ${members.length} members`);
      
      if (members.length === 2 && members.some(m => m.userId === WHATSAPP_BOT_USERID)) {
        console.log('Found existing DM room:', room.roomId);
        return room;
      }
    }
    
    console.log('No existing DM room found, will create new one');
    return null;
  } catch (error) {
    console.error('Error finding DM room:', error);
    throw error;
  }
};

// Helper function to create direct message room with WhatsApp bot
const createDirectMessageRoom = async (matrixClient) => {
  console.log('Creating new DM room with WhatsApp bot');
  
  try {
    const { room_id } = await matrixClient.createRoom({
      preset: 'trusted_private_chat',
      invite: [WHATSAPP_BOT_USERID],
      is_direct: true,
      visibility: 'private',
    });
    
    console.log('Created new DM room:', room_id);
    
    // Wait for the room to be available in the client state
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Wait for bot to join
    await waitForBotJoin(matrixClient, room_id);
    
    return matrixClient.getRoom(room_id);
  } catch (error) {
    console.error('Error creating DM room:', error);
    throw error;
  }
};

export const initializeWhatsAppConnection = async (userId) => {
  console.log('Initializing WhatsApp connection for user:', userId);
  let matrixClient = null;
  
  try {
    // Get Matrix credentials from database
    const { data: accounts, error: queryError } = await adminClient
      .from('accounts')
      .select('credentials')
      .eq('user_id', userId)
      .eq('platform', 'matrix')
      .single();

    if (queryError) throw queryError;
    if (!accounts?.credentials) {
      throw new Error('Matrix account not found. Please connect Matrix first.');
    }

    const { homeserver, access_token, user_id } = accounts.credentials;

    // Initialize Matrix client
    matrixClient = sdk.createClient({
      baseUrl: homeserver,
      accessToken: access_token,
      userId: user_id,
      validateCertificate: false
    });

    // Start client and wait for sync
    console.log('Starting Matrix client...');
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Matrix sync timeout')), 30000);
      
      matrixClient.once('sync', (state) => {
        if (state === 'PREPARED') {
          clearTimeout(timeout);
          resolve();
        }
      });

      matrixClient.startClient({ initialSyncLimit: 1 });
    });
    console.log('Matrix client synced');

    console.log('Looking for WhatsApp bot room...');
    
    // Find or create DM room with WhatsApp bot
    let dmRoom = await findDirectMessageRoom(matrixClient);
    if (!dmRoom) {
      console.log('Creating new DM room with WhatsApp bot...');
      dmRoom = await createDirectMessageRoom(matrixClient);
    }

    console.log('Sending login command to bot...');
    await matrixClient.sendMessage(dmRoom.roomId, {
      msgtype: 'm.text',
      body: '!wa login'
    });

    // Store the client in sessions
    sessions.set(userId, {
      matrixClient,
      roomId: dmRoom.roomId
    });

    // Update connection status in database
    const { error: updateError } = await adminClient
      .from('accounts')
      .upsert({
        user_id: userId,
        platform: 'whatsapp',
        status: 'pending',
        credentials: {
          bridgeRoomId: dmRoom.roomId
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

    if (updateError) throw updateError;

    // Start listening for QR code
    emitWhatsAppStatus(userId, 'initializing');
    
    return {
      status: 'pending',
      message: 'WhatsApp initialization started',
      roomId: dmRoom.roomId
    };

  } catch (error) {
    console.error('Error initializing WhatsApp:', error);
    
    // Clean up on error
    if (matrixClient) {
      try {
        await matrixClient.stopClient();
      } catch (err) {
        console.warn('Error during cleanup:', err);
      }
      sessions.delete(userId);
    }
    
    emitWhatsAppStatus(userId, 'error', { error: error.message });
    throw error;
  }
};

export const checkWhatsAppConnectionStatus = async (userId) => {
  try {
    const { data, error } = await adminClient
      .from('accounts')
      .select('status, credentials')
      .eq('user_id', userId)
      .eq('platform', 'whatsapp')
      .single();

    if (error) throw error;

    // Get Matrix client from sessions
    const matrixClient = sessions.get(userId);
    if (matrixClient && data?.credentials?.bridgeRoomId) {
      // Check for QR code or success message in bridge room
      const room = matrixClient.getRoom(data.credentials.bridgeRoomId);
      if (room) {
        const events = room.timeline
          .filter(event => event.getType() === 'm.room.message')
          .slice(-5);
        
        for (const event of events) {
          const content = event.getContent();
          if (content.msgtype === 'm.image') {
            // QR code found
            return {
              status: 'pending',
              qrCode: content.url
            };
          } else if (content.body?.includes('successfully logged in')) {
            // Login successful
            return {
              status: 'active'
            };
          }
        }
      }
    }

    return {
      status: data?.status || 'disconnected'
    };
  } catch (error) {
    console.error('Error checking WhatsApp status:', error);
    throw error;
  }
};

export const disconnectWhatsApp = async (userId) => {
  try {
    // Get Matrix client from sessions
    const matrixClient = sessions.get(userId);
    if (matrixClient) {
      const { data } = await adminClient
        .from('accounts')
        .select('credentials')
        .eq('user_id', userId)
        .eq('platform', 'whatsapp')
        .single();

      if (data?.credentials?.bridgeRoomId) {
        // Send logout command to bridge bot
        await matrixClient.sendMessage(data.credentials.bridgeRoomId, {
          msgtype: 'm.text',
          body: 'logout'
        });
      }

      // Stop and remove Matrix client
      await matrixClient.stopClient();
      sessions.delete(userId);
    }

    // Delete WhatsApp account from database
    await adminClient
      .from('accounts')
      .delete()
      .eq('user_id', userId)
      .eq('platform', 'whatsapp');

    return { status: 'disconnected' };
  } catch (error) {
    console.error('Error disconnecting WhatsApp:', error);
    throw error;
  }
};
