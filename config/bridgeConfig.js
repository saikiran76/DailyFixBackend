export const BRIDGE_CONFIGS = {
  whatsapp: {
    bridgeBot: '@whatsappbot:matrix.org',
    loginCommand: '!wa login',
    logoutCommand: '!wa logout',
    syncCommand: '!wa sync',
    qrPrefix: 'Scan this QR code',
    successMessage: 'WhatsApp connection successful',
    errorMessage: 'WhatsApp connection failed',
    syncProgressPrefix: 'Sync progress:',
    syncErrorPrefix: 'Sync error:',
    syncCompleteMessage: 'Message synchronization completed',
    inviteTimeout: 30000,
    qrTimeout: 120000,
    retryInterval: 5000,
    maxRetries: 3
  },
  telegram: {
    bridgeBot: '@telegrambot:matrix.org',
    loginCommand: '!tg login',
    logoutCommand: '!tg logout',
    syncCommand: '!tg sync',
    tokenPrefix: 'Bot token:',
    successMessage: 'Successfully logged in'
  }
};

export const BRIDGE_TIMEOUTS = {
  botJoin: 30000,
  whatsapp: 300000,
  whatsappSync: 1800000,
  telegram: 30000,
  discord: 30000,
  slack: 30000
};

export const BRIDGE_EVENTS = {
  INITIALIZING: 'initializing',
  WAITING_FOR_QR: 'waiting_for_qr',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  ERROR: 'error',
  
  connected: 'WhatsApp connection successful',
  disconnected: 'WhatsApp disconnected',
  error: 'WhatsApp connection failed',
  qrCode: 'Scan this QR code',
  syncProgress: 'Sync progress:',
  syncError: 'Sync error:',
  syncComplete: 'Message synchronization completed'
}; 