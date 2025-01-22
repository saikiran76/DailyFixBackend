// Utility function for implementing exponential backoff
export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Exponential backoff with jitter
export const getBackoffDelay = (attempt, baseDelay = 1000, maxDelay = 30000) => {
  const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  const jitter = Math.random() * 0.1 * delay; // 10% jitter
  return delay + jitter;
};

export function exponentialBackoff(attempt) {
  const baseDelay = 1000; // 1 second
  const maxDelay = 30000; // 30 seconds
  const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  return delay + Math.random() * 1000; // Add jitter
} 