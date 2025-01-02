// whatsappDirect.js

import { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeInMemoryStore } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { join } from 'path';
import { promises as fs } from 'fs';
import { adminClient } from '../../utils/supabase.js';
import { ioEmitter } from '../../utils/emitter.js';
import pino from 'pino';

const sessions = new Map();
const AUTH_FOLDER = './whatsapp-auth';
const STORE_PATH = './baileys_store.json';
const MAX_RETRIES = 3;

// Create a logger instance
const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true
    }
  }
});

// Initialize an in-memory store
const store = makeInMemoryStore({});

// Load the store from a file if it exists
// try {
//   await store.readFromFile(STORE_PATH);
//   console.log('Loaded store from file');
// } catch (error) {
//   console.warn('Store file not found, starting with an empty store');
// }

// // Periodically save the store to a file
// setInterval(() => {
//   try {
//     store.writeToFile(STORE_PATH);
//     console.log('Store successfully written to file');
//   } catch (error) {
//     console.error('Error writing store to file:', error);
//   }
// }, 10_000);

// Helper function to emit status updates
const emitWhatsAppStatus = (userId, status, data = {}) => {
  console.log(`Emitting WhatsApp status for user ${userId}:`, { status, ...data });
  try {
    ioEmitter.emit('whatsapp_status', {
      userId,
      status,
      ...data
    });
  } catch (error) {
    console.error('Error emitting WhatsApp status:', error);
  }
};

const connectionLocks = new Map();

// Helper to clear connection lock and cleanup
const clearConnectionLock = async (userId) => {
  if (connectionLocks.has(userId)) {
    console.log(`Clearing connection lock for user ${userId}`);
    connectionLocks.delete(userId);
    await cleanupSession(userId);
  }
};

// Initialize WhatsApp connection
export const initializeWhatsApp = async (userId) => {
  try {
    // Check for existing connection lock
    if (connectionLocks.get(userId)) {
      console.log(`Connection already in progress for user ${userId}`);
      throw new Error('Connection in progress');
    }
    
    // Set connection lock with timeout
    connectionLocks.set(userId, true);
    const lockTimeout = setTimeout(() => clearConnectionLock(userId), 300000); // 5 minute max lock
    
    console.log(`Initializing WhatsApp connection for user: ${userId}`);
    
    // Clean up any existing session first
    await cleanupSession(userId);
    
    const userAuthFolder = join(AUTH_FOLDER, userId);
    await fs.mkdir(userAuthFolder, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(userAuthFolder);
    const { version } = await fetchLatestBaileysVersion();

    let sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger,
      browser: ['Chrome', 'Desktop', '4.0.0'],
      version,
      connectTimeoutMs: 60000, // 1 minute
      qrTimeout: 45000, // 45 seconds
      defaultQueryTimeoutMs: 20000,
      retryRequestDelayMs: 500,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      userAgent: 'WhatsApp/2.2245.8 Chrome',
      keepAliveIntervalMs: 15000,
      emitOwnEvents: true,
      shouldIgnoreJid: jid => !jid.includes('@s.whatsapp.net'),
      mobile: false,
      generateHighQualityLinkPreview: true,
      linkPreviewImageThumbnailWidth: 192,
      transactionOpts: {
        maxCommitRetries: 10,
        delayBetweenTriesMs: 3000
      }
    });

    // Bind store to socket
    store.bind(sock.ev);

    // Save socket reference
    sessions.set(userId, sock);

    // Return a promise that resolves when connection is established or errors out
    return new Promise((resolve, reject) => {
      const connectionTimeout = setTimeout(() => {
        clearTimeout(lockTimeout);
        clearConnectionLock(userId);
        reject(new Error('Connection timeout. Please try again.'));
        cleanup();
      }, 60000); // 1 minute timeout

      const cleanup = async () => {
        clearTimeout(connectionTimeout);
        clearTimeout(lockTimeout);
        if (sock) {
          sock.ev.removeAllListeners('connection.update');
          sock.ev.removeAllListeners('creds.update');
          await sock.logout().catch(() => {});
          sock = null;
        }
        sessions.delete(userId);
        await clearConnectionLock(userId);
      };

      let hasQR = false;
      let isPaired = false;
      let isStable = false;
      let qrRetryCount = 0;
      const MAX_QR_RETRIES = 2;

      const checkConnectionStability = async () => {
        try {
          if (!sock) {
            throw new Error('Socket disconnected during stability check');
          }

          // Try to fetch some basic info to verify connection
          await sock.getOrderDetails([]);
          isStable = true;
          
          // Update database status
          await adminClient
            .from('accounts')
            .upsert({
              user_id: userId,
              platform: 'whatsapp',
              status: 'connected',
              phone_number: sock.user.id.split(':')[0],
              connected_at: new Date().toISOString()
            });

          // Update onboarding status
          await adminClient
            .from('onboarding_status')
            .update({
              whatsappConnected: true,
              connectedPlatforms: ['whatsapp'],
              currentStep: 'platform_connection'
            })
            .eq('user_id', userId);

          emitWhatsAppStatus(userId, 'connected', {
            phoneNumber: sock.user.id.split(':')[0],
            stable: true
          });
          
          resolve({ status: 'connected' });
        } catch (error) {
          console.error('Connection stability check failed:', error);
          await cleanup();
          reject(new Error('Failed to establish stable connection'));
          emitWhatsAppStatus(userId, 'error', {
            error: 'Failed to establish stable connection',
            details: 'Please try again and make sure WhatsApp is open on your phone',
            code: 'STABILITY_CHECK_FAILED'
          });
        }
      };

      // Handle connection updates
      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        console.log('Connection update:', { userId, ...update });

        try {
          if (qr) {
            if (qrRetryCount >= MAX_QR_RETRIES) {
              await cleanup();
              reject(new Error('QR code scan timeout. Please try again.'));
              emitWhatsAppStatus(userId, 'error', {
                error: 'QR code scan timeout',
                details: 'Please try again and scan the QR code quickly when it appears',
                code: 'QR_TIMEOUT'
              });
              return;
            }

            if (!hasQR) {
              hasQR = true;
              qrRetryCount++;
              emitWhatsAppStatus(userId, 'pending', { 
                qrCode: qr,
                attempt: qrRetryCount,
                maxAttempts: MAX_QR_RETRIES,
                message: 'Please scan this QR code with your WhatsApp mobile app'
              });
            }
            return;
          }

          if (connection === 'open') {
            hasQR = false;
            isPaired = true;
            qrRetryCount = 0;
            
            // Save credentials immediately
            sock.ev.on('creds.update', saveCreds);
            
            // Wait for connection to stabilize
            setTimeout(checkConnectionStability, 5000);
            
            // Emit temporary connecting status
            emitWhatsAppStatus(userId, 'connecting', {
              message: 'Establishing secure connection...'
            });
            return;
          }

          if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const disconnectError = lastDisconnect?.error;
            console.log('Disconnect details:', { statusCode, error: disconnectError?.message, isPaired, isStable });

            // Handle stream error after pairing
            if (statusCode === 515) {
              await cleanup();
              const error = new Error('Device pairing failed. Please try again with a new QR code.');
              error.code = statusCode;
              reject(error);
              emitWhatsAppStatus(userId, 'error', {
                error: error.message,
                code: statusCode,
                details: 'Please ensure WhatsApp is open on your phone and try again'
              });
              return;
            }

            await cleanup();
            const error = new Error(disconnectError?.message || 'Connection failed. Please try again.');
            error.code = statusCode;
            reject(error);
            emitWhatsAppStatus(userId, 'error', {
              error: error.message,
              code: statusCode,
              details: 'Please ensure you have a stable internet connection and WhatsApp is open on your phone'
            });
          }
        } catch (error) {
          console.error('Error in connection update handler:', error);
          await cleanup();
          reject(error);
          emitWhatsAppStatus(userId, 'error', {
            error: 'Connection error. Please try again.',
            details: error.message,
            suggestions: [
              'Ensure WhatsApp is open on your phone',
              'Check your internet connection',
              'Try logging out and back in on your phone'
            ]
          });
        }
      });
    });
  } catch (error) {
    console.error('Error in WhatsApp initialization:', error);
    await clearConnectionLock(userId);
    throw error;
  }
};

// Separate cleanup function
const cleanupSession = async (userId) => {
  try {
    const sock = sessions.get(userId);
    if (sock) {
      sock.ev.removeAllListeners();
      sessions.delete(userId);
    }
    
    const userAuthFolder = join(AUTH_FOLDER, userId);
    await fs.rm(userAuthFolder, { recursive: true, force: true }).catch(() => {});
    
  } catch (error) {
    console.error('Error cleaning up session:', error);
  }
};

// Function to disconnect WhatsApp
export const disconnectWhatsApp = async (userId) => {
  try {
    const sock = sessions.get(userId);
    if (sock) {
      sock.ev.removeAllListeners();
      await sock.logout().catch(console.error);
      sessions.delete(userId);
    }

    // Delete auth files
    const userAuthFolder = join(AUTH_FOLDER, userId);
    await fs.rm(userAuthFolder, { recursive: true, force: true });

    // Update database
    await adminClient
      .from('accounts')
      .delete()
      .eq('user_id', userId)
      .eq('platform', 'whatsapp');

    emitWhatsAppStatus(userId, 'disconnected');
    return { status: 'disconnected' };
  } catch (error) {
    console.error('Error disconnecting WhatsApp:', error);
    throw error;
  }
};

// Function to send a WhatsApp message
export const sendWhatsAppMessage = async (userId, recipient, message) => {
  try {
    const sock = sessions.get(userId);
    if (!sock) {
      throw new Error('WhatsApp not connected');
    }

    const formattedNumber = recipient.replace(/\D/g, '');
    const jid = `${formattedNumber}@s.whatsapp.net`;

    const result = await sock.sendMessage(jid, { text: message });
    return {
      messageId: result.key.id,
      timestamp: result.messageTimestamp
    };
  } catch (error) {
    console.error('Error sending WhatsApp message:', error);
    throw error;
  }
};

// Function to check WhatsApp connection status
export const checkWhatsAppStatus = async (userId) => {
  try {
    const sock = sessions.get(userId);
    if (!sock) {
      return { status: 'disconnected' };
    }

    const { data: account } = await adminClient
      .from('accounts')
      .select('status, credentials')
      .eq('user_id', userId)
      .eq('platform', 'whatsapp')
      .single();

    return {
      status: account?.status || 'disconnected',
      whatsappId: account?.credentials?.whatsappId
    };
  } catch (error) {
    console.error('Error checking WhatsApp status:', error);
    throw error;
  }
};

// Function to finalize WhatsApp connection
export const finalizeWhatsApp = async (userId) => {
  try {
    const sock = sessions.get(userId);
    if (!sock) {
      throw new Error('No active WhatsApp connection');
    }

    // Verify connection is stable
    await sock.getOrderDetails([]);

    // Update database status
    await adminClient
      .from('accounts')
      .update({
        status: 'connected',
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId)
      .eq('platform', 'whatsapp');

    emitWhatsAppStatus(userId, 'connected', {
      phoneNumber: sock.user.id.split(':')[0]
    });

    return { 
      status: 'connected',
      phoneNumber: sock.user.id.split(':')[0]
    };
  } catch (error) {
    console.error('Error finalizing WhatsApp:', error);
    throw error;
  }
};
