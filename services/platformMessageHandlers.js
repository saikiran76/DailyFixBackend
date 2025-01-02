import { BRIDGE_CONFIGS, BRIDGE_TIMEOUTS } from '../config/bridgeConfig.js';
// import { supabase } from '../utils/supabase.js';
import { ioEmitter } from '../utils/emitter.js';

export async function handleWhatsAppMessage(bridge, event, room) {
  if (!checkRateLimit(bridge.userId)) {
    console.warn(`Rate limit exceeded for user ${bridge.userId}`);
    return;
  }

  const content = event.getContent();
  // WhatsApp specific message handling
  // Implementation here
}

export async function handleTelegramMessage(bridge, event, room) {
  if (!checkRateLimit(bridge.userId)) {
    console.warn(`Rate limit exceeded for user ${bridge.userId}`);
    return;
  }

  const content = event.getContent();
  // Telegram specific message handling
  // Implementation here
}

function checkRateLimit(userId) {
  // Rate limiting logic moved from bridgeMessageService.js
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

const messageRateLimit = new Map();
const RATE_LIMIT = {
  windowMs: 60000,
  max: 30
}; 