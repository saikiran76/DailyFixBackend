import Message from '../models/Message.js';
import Account from '../models/Account.js';

export async function getConsolidatedMessages(userId) {
  const userAccounts = await Account.find({ userId }).lean();
  const connectedPlatforms = userAccounts.map(a => a.platform);

  const messages = await Message.find({ platform: { $in: connectedPlatforms } }).lean();

  const priorityOrder = { high: 1, medium: 2, low: 3 };
  messages.sort((a,b) => {
    const prioA = priorityOrder[a.priority] || 3;
    const prioB = priorityOrder[b.priority] || 3;
    if (prioA !== prioB) return prioA - prioB;
    return new Date(b.timestamp) - new Date(a.timestamp);
  });

  return messages;
}
