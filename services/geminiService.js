import axios from 'axios';

const GEMINI_ENDPOINT = process.env.GEMINI_API_ENDPOINT;

export async function analyzeMessagesWithGemini(messages) {
  // Send last N messages
  const lastMessages = messages.slice(0,50); 
  const textContent = lastMessages.map(m=>`${m.senderName}: ${m.content}`).join('\n');

  const prompt = `Analyze these messages and provide a JSON response:
  {
    "conversationTone": "string",
    "mainTopics": [array of topics],
    "actionItems": [array of required actions],
    "customerSentiment": "string",
    "suggestedNextSteps": [array of suggestions]
  }
  Messages:
  "${textContent}"`;

  const resp = await axios.post(GEMINI_ENDPOINT, {
    prompt
  },{
    headers:{'Authorization':`Bearer ${process.env.GEMINI_API_KEY}`}
  });

  return resp.data;
}
