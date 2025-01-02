import NodeCache from 'node-cache';

const messageCache = new NodeCache({
  stdTTL: 3600, // 1 hour cache
  checkperiod: 120 // Check for expired entries every 2 minutes
});

export const cacheKey = (content, type) => {
  return `${type}_${Buffer.from(content).toString('base64')}`;
};

export const getCachedAnalysis = (content, type) => {
  return messageCache.get(cacheKey(content, type));
};

export const setCachedAnalysis = (content, type, analysis) => {
  return messageCache.set(cacheKey(content, type), analysis);
};