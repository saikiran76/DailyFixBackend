import { Telegraf } from 'telegraf';
import { adminClient } from '../../utils/supabase.js';
import { ioEmitter } from '../../utils/emitter.js';
import { encryptToken } from '../../utils/encryption.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Connection states enum
const ConnectionState = {
  DISCONNECTED: 'disconnected',
  INITIALIZING: 'initializing',
  AWAITING_TOKEN: 'awaiting_token',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  ERROR: 'error'
};

// Constants for account status
const AccountStatus = {
  PENDING: 'pending',
  ACTIVE: 'active',
  INACTIVE: 'inactive'
};

// Single source of truth for connection state
class ConnectionManager {
  #connections = new Map();
  #locks = new Map();
  #rateLimits = new Map();
  #lockTimeout = 300000; // 5 minutes timeout
  #staleLockTimeout = 60000; // 1 minute for stale locks

  #emitStatus(userId, status, data = {}) {
    ioEmitter.emit('telegram_status', {
      userId,
      status,
      ...data,
      timestamp: Date.now()
    });
  }

  async #acquireLock(userId) {
    const lockKey = `${userId}-telegram`;
    
    try {
      // Check for existing lock first
      if (this.#locks.has(lockKey)) {
        const existingLock = this.#locks.get(lockKey);
        const timeSinceLock = Date.now() - existingLock.timestamp;
        
        // If lock is too old, force cleanup and release
        if (timeSinceLock > this.#staleLockTimeout && 
            !existingLock.isFinalizationInProgress) {
          console.log(`Force releasing stale lock for ${userId}`);
          await this.#cleanup(userId, 'stale_lock');
        } else {
          const connection = this.#connections.get(userId);
          // Allow reentry if in AWAITING_TOKEN state or during finalization
          if (connection?.state === ConnectionState.AWAITING_TOKEN ||
              existingLock.isFinalizationInProgress) {
            return;
          }
          throw new Error('Connection operation already in progress. Please wait a moment.');
        }
      }

      // Set new lock
      const timeoutId = setTimeout(() => this.#handleLockTimeout(userId), this.#lockTimeout);
      this.#locks.set(lockKey, {
        timestamp: Date.now(),
        timeoutId,
        released: false,
        isFinalizationInProgress: false
      });

      console.log(`Lock acquired for ${lockKey}`);
    } catch (error) {
      console.error(`Error acquiring lock for ${userId}:`, error);
      throw error;
    }
  }

  async #releaseLock(userId) {
    const lockKey = `${userId}-telegram`;
    const lock = this.#locks.get(lockKey);
    
    if (lock && !lock.released) {
      clearTimeout(lock.timeoutId);
      this.#locks.delete(lockKey);
      console.log(`Lock released for ${lockKey}`);
    }
  }

  async #handleLockTimeout(userId) {
    try {
      console.log(`Lock timeout for user ${userId}`);
      const connection = this.#connections.get(userId);
      
      // Only cleanup if not in CONNECTED or AWAITING_TOKEN state
      if (!connection || 
          (connection.state !== ConnectionState.CONNECTED && 
           connection.state !== ConnectionState.AWAITING_TOKEN)) {
        await this.#cleanup(userId, 'timeout');
        this.#emitStatus(userId, 'error', {
          error: 'Connection timeout. Please try again.'
        });
      }
    } catch (error) {
      console.error(`Error handling lock timeout for ${userId}:`, error);
    }
  }

  async #cleanup(userId, reason = 'cleanup', clearState = true) {
    const lockKey = `${userId}-telegram`;
    console.log(`Cleaning up Telegram connection for user ${userId}, reason: ${reason}`);

    try {
      // Get current connection state
      const connection = this.#connections.get(userId);
      
      // Don't cleanup if in AWAITING_TOKEN state unless explicitly requested
      if (connection?.state === ConnectionState.AWAITING_TOKEN && 
          !['user_disconnect', 'stale_lock', 'force_cleanup', 'timeout'].includes(reason)) {
        return;
      }

      // Stop bot if exists
      if (connection?.bot) {
        try {
          console.log(`Stopping bot for user ${userId}`);
          // Add timeout to bot.stop()
          await Promise.race([
            connection.bot.stop('cleanup'),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Bot stop timed out')), 5000)
            )
          ]);
          // Add a small delay to ensure the bot is fully stopped
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.error('Error stopping bot:', error);
        }
      }

      // Update account status in database
      try {
        const { error: updateError } = await adminClient
          .from('accounts')
          .update({ 
            status: AccountStatus.INACTIVE,
            updated_at: new Date().toISOString()
          })
          .eq('user_id', userId)
          .eq('platform', 'telegram')
          .in('status', [AccountStatus.PENDING, AccountStatus.ACTIVE]);

        if (updateError) {
          console.error('Error updating account status:', updateError);
        }
      } catch (error) {
        console.error('Error updating account status:', error);
      }

      // Clear connection state only if clearState is true
      if (clearState) {
        this.#connections.delete(userId);
      } else {
        // Remove only the bot instance if it exists
        if (connection?.bot) {
          const { bot, ...rest } = connection;
          this.#connections.set(userId, rest);
        }
      }

      // Release lock if exists
      const lock = this.#locks.get(lockKey);
      if (lock) {
        clearTimeout(lock.timeoutId);
        this.#locks.delete(lockKey);
      }

      // Emit disconnected status with error details if applicable
      const statusData = {
        reason,
        timestamp: Date.now()
      };

      if (['timeout', 'network_error', 'conflict_error'].includes(reason)) {
        statusData.error = true;
        statusData.errorMessage = this.#getErrorMessage(reason);
      }

      // Only emit disconnected status if we're clearing state
      if (clearState) {
        this.#emitStatus(userId, 'disconnected', statusData);
      }

    } catch (error) {
      console.error(`Error during cleanup for ${userId}:`, error);
    }
  }

  #getErrorMessage(reason) {
    switch (reason) {
      case 'timeout':
        return 'Connection timed out. Please try again.';
      case 'network_error':
        return 'Network error occurred. Please check your connection and try again.';
      case 'conflict_error':
        return 'Another bot instance is already running. Please try again in a moment.';
      default:
        return 'An error occurred during connection.';
    }
  }

  async initialize(userId) {
    console.log(`Initializing Telegram for user ${userId}`);
    
    try {
      // Acquire lock first
      await this.#acquireLock(userId);

      // Set initial state
      this.#connections.set(userId, {
        state: ConnectionState.INITIALIZING,
        timestamp: Date.now()
      });

      // Emit status update
      this.#emitStatus(userId, 'pending', {
        requiresToken: true,
        message: 'Please provide your Telegram bot token'
      });

      // Update state to awaiting token
      this.#connections.set(userId, {
        state: ConnectionState.AWAITING_TOKEN,
        timestamp: Date.now()
      });

      return {
        status: 'pending',
        requiresToken: true
      };
    } catch (error) {
      console.error(`Error initializing Telegram for ${userId}:`, error);
      await this.#cleanup(userId, 'initialization_error');
      throw error;
    }
  }

  async #stopExistingBot(userId) {
    try {
      // Check if there's an existing account with an active bot
      const { data: existingAccount, error } = await adminClient
        .from('accounts')
        .select('*')
        .eq('user_id', userId)
        .eq('platform', 'telegram')
        .eq('status', AccountStatus.ACTIVE)
        .single();

      if (existingAccount) {
        // Update status to inactive
        await adminClient
          .from('accounts')
          .update({ 
            status: AccountStatus.INACTIVE,
            updated_at: new Date().toISOString()
          })
          .eq('user_id', userId)
          .eq('platform', 'telegram');

        // If there's an existing bot instance, stop it
        const existingConnection = this.#connections.get(userId);
        if (existingConnection?.bot) {
          try {
            await existingConnection.bot.stop('new_connection');
            console.log(`Stopped existing bot for user ${userId}`);
          } catch (error) {
            console.error('Error stopping existing bot:', error);
          }
        }
      }
    } catch (error) {
      console.error('Error stopping existing bot:', error);
    }
  }

  async finalize(userId, token) {
    console.log(`Finalizing Telegram connection for user ${userId}`);
    let bot = null;
    
    try {
      // Mark finalization as in progress
      const lockKey = `${userId}-telegram`;
      const lock = this.#locks.get(lockKey);
      if (lock) {
        lock.isFinalizationInProgress = true;
      }

      // Verify we have an active connection attempt first
      const connection = this.#connections.get(userId);
      console.log('Current connection state:', connection?.state);
      
      if (!connection || connection.state !== ConnectionState.AWAITING_TOKEN) {
        throw new Error('No active connection to finalize. Please start a new connection.');
      }

      // Store connection state before cleanup
      const connectionState = connection.state;

      // Force cleanup of any existing connections first
      await this.#cleanup(userId, 'force_cleanup', false); // Added false to prevent state clearing
      
      // Add delay after cleanup to ensure Telegram registers the termination
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Restore connection state after cleanup
      this.#connections.set(userId, {
        state: connectionState,
        timestamp: Date.now()
      });

      // Validate token format
      if (!token) {
        throw new Error('Bot token is required');
      }

      if (!token.match(/^\d+:[A-Za-z0-9_-]{35}$/)) {
        throw new Error('Invalid bot token format. Please make sure you copied the entire token from BotFather');
      }

      // Create bot instance with shorter timeouts
      bot = new Telegraf(token, {
        handlerTimeout: 15000,
        telegram: {
          timeout: 10000,
          webhookReply: false
        }
      });

      try {
        // Quick validation of token with short timeout
        const botInfo = await Promise.race([
          bot.telegram.getMe(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Token validation timed out')), 10000)
          )
        ]);
        
        console.log('Bot info received:', botInfo);

        // Store initial credentials in database with pending status
        const { error: upsertError } = await adminClient
          .from('accounts')
          .upsert({
            user_id: userId,
            platform: 'telegram',
            credentials: { 
              token: encryptToken(token),
              botId: botInfo.id.toString(),
              botUsername: botInfo.username
            },
            status: AccountStatus.PENDING,
            updated_at: new Date().toISOString()
          }, {
            onConflict: 'user_id,platform'
          });

        if (upsertError) throw upsertError;

        // Update connection state
        this.#connections.set(userId, {
          botInfo,
          state: ConnectionState.CONNECTING,
          timestamp: Date.now()
        });

        // Emit connecting status
        this.#emitStatus(userId, 'connecting', { botInfo });

        console.log('Initializing bot...');
        
        // Delete webhook with short timeout
        await Promise.race([
          bot.telegram.deleteWebhook({ drop_pending_updates: true }),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Webhook deletion timed out')), 10000)
          )
        ]);

        // Set up bot event handlers with error handling
        bot.on('message', (ctx) => {
          console.log(`Received message for user ${userId}:`, ctx.message);
        });

        bot.catch((error) => {
          console.error(`Bot error for user ${userId}:`, error);
        });

        // Launch bot with multiple retries and exponential backoff
        let retryCount = 0;
        const maxRetries = 2;
        let lastError = null;

        while (retryCount <= maxRetries) {
          try {
            console.log(`Attempting bot launch (attempt ${retryCount + 1}/${maxRetries + 1})`);
            
            // Launch with short timeout
            await Promise.race([
              bot.launch({
                polling: {
                  timeout: 10,
                  limit: 100,
                  allowedUpdates: ['message', 'callback_query']
                }
              }),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Bot launch timed out')), 15000)
              )
            ]);

            console.log('Bot successfully launched');
            break; // Success, exit retry loop
          } catch (error) {
            lastError = error;
            console.error(`Launch attempt ${retryCount + 1} failed:`, error);

            if (error.response?.error_code === 409) {
              console.log('Conflict detected, cleaning up...');
              await this.#cleanup(userId, 'conflict_retry');
              // Exponential backoff
              await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
              retryCount++;
              continue;
            }

            // For other errors, throw immediately
            throw error;
          }
        }

        // If we exhausted all retries
        if (retryCount > maxRetries) {
          throw lastError || new Error('Failed to launch bot after multiple attempts');
        }

        // Update connection state with bot instance
        this.#connections.set(userId, {
          bot,
          botInfo,
          state: ConnectionState.CONNECTED,
          timestamp: Date.now()
        });

        // Update database status to active
        await adminClient
          .from('accounts')
          .update({ 
            status: AccountStatus.ACTIVE,
            updated_at: new Date().toISOString()
          })
          .eq('user_id', userId)
          .eq('platform', 'telegram');

        // Clear the lock
        await this.#releaseLock(userId);

        // Emit final success status
        this.#emitStatus(userId, 'connected', { botInfo });

        // Return success with bot info
        return {
          status: 'connected',
          botInfo
        };

      } catch (error) {
        console.error('Bot initialization error:', error);
        
        // Ensure bot is stopped if it exists
        if (bot) {
          try {
            await bot.stop();
          } catch (stopError) {
            console.error('Error stopping bot during cleanup:', stopError);
          }
        }

        // Update account status to inactive on error
        try {
          await adminClient
            .from('accounts')
            .update({ 
              status: AccountStatus.INACTIVE,
              updated_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .eq('platform', 'telegram');
        } catch (updateError) {
          console.error('Error updating account status:', updateError);
        }

        if (error.response?.error_code === 409) {
          await this.#cleanup(userId, 'conflict_error');
          throw new Error('Another bot instance is already running. Please try again in a moment.');
        }
        
        if (error.description?.includes('Unauthorized')) {
          throw new Error('Invalid bot token. Please check if you copied the correct token from BotFather');
        }

        if (error.message?.includes('timed out')) {
          await this.#cleanup(userId, 'timeout');
          throw new Error('Connection to Telegram servers timed out. Please try again.');
        }

        if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
          await this.#cleanup(userId, 'network_error');
          throw new Error('Could not connect to Telegram servers. Please check your internet connection and try again.');
        }

        throw error;
      }

    } catch (error) {
      console.error(`Error finalizing Telegram connection for ${userId}:`, error);
      await this.#cleanup(userId, 'finalization_error');
      throw error;
    }
  }

  async #startBotInBackground(userId, token, botInfo) {
    let retryCount = 0;
    const MAX_RETRIES = 2;

    const initializeBot = async () => {
      console.log(`Attempting bot initialization in background (attempt ${retryCount + 1}/${MAX_RETRIES + 1})`);

      const bot = new Telegraf(token, {
        handlerTimeout: 90000,
        telegram: {
          timeout: 30000,
          webhookReply: false
        }
      });

      try {
        // Delete webhook before starting polling
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });

        // Set up bot event handlers
        bot.on('message', (ctx) => {
          console.log(`Received message for user ${userId}:`, ctx.message);
        });

        // Start the bot with custom polling options
        await bot.launch({
          polling: {
            timeout: 30,
            limit: 100,
            allowedUpdates: ['message', 'callback_query']
          }
        });

        // Update connection state with bot instance
        this.#connections.set(userId, {
          bot,
          botInfo,
          state: ConnectionState.CONNECTED,
          timestamp: Date.now()
        });

        // Update database status
        await adminClient
          .from('accounts')
          .update({ 
            status: 'connected',
            updated_at: new Date().toISOString()
          })
          .eq('user_id', userId)
          .eq('platform', 'telegram');

        // Clear the lock
        await this.#releaseLock(userId);

        // Emit final success status
        this.#emitStatus(userId, 'connected', { botInfo });

      } catch (error) {
        console.error(`Background bot initialization attempt ${retryCount + 1} failed:`, error);
        
        if (error.response?.error_code === 409) {
          if (retryCount < MAX_RETRIES) {
            console.log('Conflict detected, cleaning up and retrying...');
            await this.#cleanup(userId, 'conflict_retry');
            await new Promise(resolve => setTimeout(resolve, 2000));
            retryCount++;
            return initializeBot();
          }
        }

        // If all retries failed, cleanup and emit error
        await this.#cleanup(userId, 'initialization_failed');
        this.#emitStatus(userId, 'error', { 
          error: 'Failed to initialize bot after multiple attempts',
          botInfo 
        });
      }
    };

    // Start initialization in background
    initializeBot().catch(error => {
      console.error('Background initialization failed:', error);
    });
  }

  async getStatus(userId) {
    const connection = this.#connections.get(userId);
    return {
      status: connection?.state || ConnectionState.DISCONNECTED,
      botInfo: connection?.botInfo
    };
  }

  async disconnect(userId) {
    try {
      await this.#cleanup(userId, 'user_disconnect');
      return { status: 'disconnected' };
    } catch (error) {
      console.error(`Error disconnecting Telegram for ${userId}:`, error);
      throw error;
    }
  }

  getConnectionState(userId) {
    return this.#connections.get(userId)?.state || ConnectionState.DISCONNECTED;
  }
}

const connectionManager = new ConnectionManager();

export const initializeTelegram = (userId) => connectionManager.initialize(userId);
export const finalizeTelegram = (userId, token) => connectionManager.finalize(userId, token);
export const checkTelegramStatus = (userId) => connectionManager.getStatus(userId);
export const disconnectTelegram = (userId) => connectionManager.disconnect(userId);

// Helper function to send messages
export const sendTelegramMessage = async (userId, chatId, message) => {
  const state = connectionManager.getConnectionState(userId);
  const connection = connectionManager.getStatus(userId);
  
  if (state === ConnectionState.DISCONNECTED || !connection.botInfo) {
    throw new Error('No active Telegram connection');
  }

  try {
    return await connection.bot.telegram.sendMessage(chatId, message);
  } catch (error) {
    console.error(`Error sending Telegram message for ${userId}:`, error);
    throw error;
  }
}; 