import Rules from '../models/Rules.js';
import { sendPlatformMessage } from './messageService.js';
import { ioEmitter } from '../utils/emitter.js';

export async function applyRulesToMessage(message, userId) {
  const rules = await Rules.find({ userId }).lean();
  for (const rule of rules) {
    if (matchesConditions(message, rule.conditions)) {
      if (rule.actions.priority) {
        message.priority = rule.actions.priority;
      }
      if (rule.actions.autoRespond && rule.actions.autoResponseText) {
        try {
          await sendPlatformMessage(message.platform, message.roomId, rule.actions.autoResponseText);
        } catch (err) {
          console.error('Auto-response sending failed:', err);
        }
      }
    }
  }
  return message;
}

function matchesConditions(message, conditions) {
  if (!conditions || !Array.isArray(conditions) || conditions.length === 0) {
    return true;
  }

  return conditions.every(condition => {
    switch (condition.type) {
      case 'contains':
        return message.content.toLowerCase().includes(condition.value.toLowerCase());
      case 'equals':
        return message.content.toLowerCase() === condition.value.toLowerCase();
      case 'sender':
        return message.sender === condition.value;
      case 'priority':
        return message.priority === condition.value;
      default:
        console.warn(`Unknown condition type: ${condition.type}`);
        return true;
    }
  });
}

// Listen for message rule processing events
ioEmitter.on('process_message_rules', async ({ message, userId }) => {
  try {
    const processedMessage = await applyRulesToMessage(message, userId);
    ioEmitter.emit('message_rules_processed', processedMessage);
  } catch (err) {
    console.error('Error processing message rules:', err);
  }
});
