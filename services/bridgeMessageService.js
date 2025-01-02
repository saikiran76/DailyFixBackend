import sdk from 'matrix-js-sdk';
import supabase from '../utils/supabase.js';
import { ioEmitter } from '../utils/emitter.js';
import { bridges } from './matrixBridgeService.js';
import { handleWhatsAppMessage, handleTelegramMessage } from './platformMessageHandlers.js';

// Add rate limiting using a simple in-memory store
const messageRateLimit = new Map();
const RATE_LIMIT = {
  windowMs: 60000, // 1 minute
  max: 30 // messages per window
};

function checkRateLimit(userId) {
  const now = Date.now();
  const userLimit = messageRateLimit.get(userId) || { count: 0, resetTime: now + RATE_LIMIT.windowMs };

  if (now > userLimit.resetTime) {
    messageRateLimit.set(userId, { count: 1, resetTime: now + RATE_LIMIT.windowMs });
    return true;
  }

  if (userLimit.count >= RATE_LIMIT.max) {
    return false;
  }

  userLimit.count++;
  messageRateLimit.set(userId, userLimit);
  return true;
}

// Handle incoming Matrix messages and forward to appropriate platform
export async function handleMatrixMessage(event, room, bridge) {
  if (event.getType() !== 'm.room.message') return;
  if (event.getSender() === bridge.matrixClient.getUserId()) return;

  switch (bridge.platform) {
    case 'whatsapp':
      await handleWhatsAppMessage(bridge, event, room);
      break;
    case 'telegram':
      await handleTelegramMessage(bridge, event, room);
      break;
    default:
      console.warn(`Unsupported platform ${bridge.platform} for message handling`);
  }
}

// Handle incoming platform messages and forward to Matrix
export async function handlePlatformMessage(platform, channelId, content, userId) {
  if (!checkRateLimit(userId)) {
    throw new Error('Rate limit exceeded. Please try again later.');
  }

  const bridge = bridges.get(`${userId}-${platform}`);
  if (!bridge) return;

  const targetRoomId = bridge.mappings.get(channelId);
  if (!targetRoomId) return;

  let retries = 3;
  let lastError;

  while (retries > 0) {
    try {
      await bridge.matrixClient.sendMessage(targetRoomId, {
        msgtype: 'm.text',
        body: content
      });

      const { error } = await supabase
        .from('messages')
        .insert({
          content,
          sender_id: userId,
          platform,
          room_id: channelId,
          bridged: true,
          bridge_target: 'matrix'
        });

      if (error) throw error;

      ioEmitter.emit('new_message', {
        content,
        sender_id: userId,
        platform,
        room_id: channelId
      });

      return;
    } catch (error) {
      lastError = error;
      if (error.name === 'M_FORBIDDEN') {
        throw error; // Don't retry permission errors
      }
      retries--;
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
      }
    }
  }

  throw lastError || new Error('Failed to send message after retries');
}

// Sync message history
export async function syncMessageHistory(userId, platform, channelId, roomId) {
  const bridge = bridges.get(`${userId}-${platform}`);
  if (!bridge) return;

  try {
    // Get recent messages from Matrix room
    const matrixMessages = await bridge.matrixClient.getRoomMessages(roomId, null, 50, 'b');
    
    // Get recent messages from platform through Supabase
    const { data: platformMessages, error } = await supabase
      .from('messages')
      .select('*')
      .eq('platform', platform)
      .eq('room_id', channelId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    // Create a map of message IDs to avoid duplicates
    const processedMessages = new Set();

    // Process and save Matrix messages
    for (const event of matrixMessages.chunk) {
      if (event.type !== 'm.room.message') continue;
      
      const messageId = event.event_id;
      if (processedMessages.has(messageId)) continue;
      
      processedMessages.add(messageId);
      
      const { error: upsertError } = await supabase
        .from('messages')
        .upsert({
          message_id: messageId,
          content: event.content.body,
          sender_id: userId,
          platform: 'matrix',
          room_id: roomId,
          created_at: new Date(event.origin_server_ts).toISOString(),
          bridged: true,
          bridge_source: platform,
          synced: true
        });

      if (upsertError) throw upsertError;
    }

    // Mark platform messages as synced
    for (const msg of platformMessages) {
      if (processedMessages.has(msg.id)) continue;
      
      const { error: updateError } = await supabase
        .from('messages')
        .update({
          synced: true,
          bridged: true,
          bridge_target: 'matrix'
        })
        .eq('id', msg.id);

      if (updateError) throw updateError;
    }

    ioEmitter.emit('sync_completed', {
      userId,
      platform,
      channelId,
      roomId
    });
  } catch (error) {
    console.error('Error syncing message history:', error);
    throw error;
  }
} 