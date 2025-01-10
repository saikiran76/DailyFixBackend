export const BRIDGE_CONFIGS = {
  whatsapp: {
    bridgeBot: '@whatsappbot:example-mtbr.duckdns.org',
    loginCommand: '!wa login',
    logoutCommand: '!wa logout',
    syncCommand: '!wa sync',
    qrPrefix: 'QR code:',
    successMessage: 'Successfully logged in',
    connected: 'Successfully logged in',
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
  whatsapp: 300000,
  whatsappSync: 1800000,
  telegram: 30000,
  discord: 30000,
  slack: 30000
};

export const BRIDGE_EVENTS = {
  connected: 'Successfully logged in',
  disconnected: 'Logged out',
  error: 'Error:',
  qrCode: 'Please scan the following QR code:',
  syncProgress: 'Sync progress:',
  syncError: 'Sync error:',
  syncComplete: 'Message synchronization completed'
}; 