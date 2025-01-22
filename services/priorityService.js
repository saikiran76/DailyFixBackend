import { adminClient } from '../utils/supabase.js';
import { logger } from '../utils/logger.js';
import { redisClient } from './redisService.js';
import { whatsappEntityService } from './whatsappEntityService.js';

const PRIORITY_PATTERNS = {
  URGENT: /\b(urgent|asap|emergency|critical)\b/i,
  HIGH: /\b(important|priority|high|needed)\b/i,
  MEDIUM: /\b(please|when possible|soon)\b/i,
  LOW: /\b(whenever|fyi|just|maybe)\b/i
};

const PRIORITY_LEVELS = {
  URGENT: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1
};

class PriorityService {
  constructor() {
    this.processingQueue = new Map();
  }

  async extractPriorities(userId, contactId, message) {
    try {
      // Check if message already processed
      const isProcessed = await this.checkProcessed(message.id);
      if (isProcessed) {
        return null;
      }

      // Extract priority level
      const priority = this.analyzePriority(message.content);

      if (priority) {
        // Store priority
        const { data, error } = await adminClient
          .from('whatsapp_priorities')
          .insert({
            user_id: userId,
            contact_id: contactId,
            message_id: message.id,
            priority_level: priority.level,
            priority_score: priority.score,
            context: priority.context,
            metadata: {
              extracted_at: new Date().toISOString(),
              patterns_matched: priority.patterns
            }
          });

        if (error) throw error;

        // Invalidate cache
        await whatsappEntityService.invalidatePriorityCache(userId, contactId);

        return data;
      }

      return null;
    } catch (error) {
      logger.error('[Priority Service] Error extracting priorities:', error);
      throw error;
    }
  }

  async processBatch(userId, contactId, messages) {
    try {
      const queueKey = `${userId}:${contactId}`;
      
      // Check if already processing
      if (this.processingQueue.get(queueKey)) {
        return;
      }

      this.processingQueue.set(queueKey, true);

      try {
        const priorities = await Promise.all(
          messages.map(msg => this.extractPriorities(userId, contactId, msg))
        );

        // Filter out nulls and sort by priority level
        return priorities
          .filter(p => p)
          .sort((a, b) => b.priority_score - a.priority_score);
      } finally {
        this.processingQueue.delete(queueKey);
      }
    } catch (error) {
      logger.error('[Priority Service] Error processing batch:', error);
      throw error;
    }
  }

  analyzePriority(content) {
    let maxLevel = 0;
    let matchedPatterns = [];

    // Check each priority pattern
    for (const [level, pattern] of Object.entries(PRIORITY_PATTERNS)) {
      if (pattern.test(content)) {
        matchedPatterns.push(level);
        maxLevel = Math.max(maxLevel, PRIORITY_LEVELS[level]);
      }
    }

    if (maxLevel === 0) {
      return null;
    }

    // Extract context (surrounding text)
    const context = this.extractContext(content, matchedPatterns);

    return {
      level: Object.keys(PRIORITY_LEVELS).find(k => PRIORITY_LEVELS[k] === maxLevel),
      score: maxLevel,
      patterns: matchedPatterns,
      context
    };
  }

  extractContext(content, patterns) {
    // Get text around matched patterns
    const contexts = patterns.map(pattern => {
      const regex = PRIORITY_PATTERNS[pattern];
      const match = regex.exec(content);
      if (match) {
        const start = Math.max(0, match.index - 50);
        const end = Math.min(content.length, match.index + match[0].length + 50);
        return content.slice(start, end);
      }
      return null;
    });

    return contexts.filter(c => c);
  }

  async checkProcessed(messageId) {
    try {
      const { data } = await adminClient
        .from('whatsapp_priorities')
        .select('id')
        .eq('message_id', messageId)
        .single();

      return !!data;
    } catch (error) {
      logger.error('[Priority Service] Error checking processed status:', error);
      return false;
    }
  }

  async getPriorities(userId, contactId, options = { limit: 10 }) {
    return whatsappEntityService.getPriorities(userId, contactId, options);
  }
}

export const priorityService = new PriorityService(); 