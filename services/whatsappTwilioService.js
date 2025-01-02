import twilio from 'twilio';

export const initializeWhatsAppClient = () => {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      throw new Error('Missing Twilio credentials');
    }

    const client = twilio(accountSid, authToken);
    return client;
  } catch (error) {
    console.error('WhatsApp client initialization error:', error);
    throw error;
  }
};

export const getWhatsAppMessages = async (client, phoneNumber, limit = 50) => {
  try {
    const messages = await client.messages.list({
      from: `whatsapp:${phoneNumber}`,
      limit
    });

    return messages.map(msg => ({
      id: msg.sid,
      content: msg.body,
      sender: msg.from,
      timestamp: new Date(msg.dateCreated).getTime(),
      platform: 'whatsapp',
      priority: calculateWhatsAppMessagePriority(msg.body)
    })).reverse();
  } catch (error) {
    console.error('Error fetching WhatsApp messages:', error);
    throw error;
  }
};

const calculateWhatsAppMessagePriority = (content) => {
  // Similar to Discord priority calculation
  const urgentKeywords = ['urgent', 'emergency', 'help now'];
  const mediumKeywords = ['help', 'question', 'support'];

  content = content.toLowerCase();

  if (urgentKeywords.some(keyword => content.includes(keyword))) {
    return 'high';
  }
  
  if (mediumKeywords.some(keyword => content.includes(keyword))) {
    return 'medium';
  }

  return 'low';
};