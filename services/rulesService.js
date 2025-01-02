import Rules from '../models/Rules.js';
import { sendWhatsAppMessage } from './whatsappService.js';
import { sendTelegramMessage } from './telegramService.js';
import { sendSlackMessage } from './slackService.js';

export async function applyRulesToMessage(message, userId) {
  const rules = await Rules.find({ userId }).lean();
  for (const rule of rules) {
    if (matchesConditions(message, rule.conditions)) {
      if (rule.actions.priority) {
        message.priority = rule.actions.priority;
      }
      if (rule.actions.autoRespond && rule.actions.autoResponseText) {
        // Immediately send an automated response
        try {
          await sendAutoResponse(message, rule.actions.autoResponseText);
        } catch (err) {
          console.error('Auto-response sending failed:', err);
        }
      }
    }
  }
  return message;
}

async function sendAutoResponse(message, responseText) {
  switch (message.platform) {
    case 'whatsapp':
      await sendWhatsAppMessage(message.roomId, responseText);
      break;
    case 'telegram':
      await sendTelegramMessage(message.roomId, responseText);
      break;
    case 'slack':
      await sendSlackMessage(message.roomId, responseText);
      break;
    default:
      console.log(`No auto-response handler for platform ${message.platform}`);
  }
}

function matchesConditions(message, conditions) {
  for (const cond of conditions) {
    const val = message[cond.field];
    if (!evaluateCondition(val, cond.op, cond.value)) return false;
  }
  return true;
}

function evaluateCondition(val, op, expected) {
  val = String(val || '').toLowerCase();
  expected = String(expected || '').toLowerCase();
  switch (op) {
    case 'contains': return val.includes(expected);
    case 'equals': return val === expected;
    default: return false;
  }
}
