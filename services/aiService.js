import { RateLimiter } from 'limiter';
import { analyzeMessagesWithGemini } from './geminiService.js';

const limiter = new RateLimiter({ tokensPerInterval: 10, interval: 'minute' });

export async function generateAISummary(messages) {
  const hasToken= await limiter.tryRemoveTokens(1);
  if(!hasToken) {
    return { summary:'API rate limit reached. Try again later.' };
  }
  const result=await analyzeMessagesWithGemini(messages);
  return { summary: JSON.stringify(result) };
}
