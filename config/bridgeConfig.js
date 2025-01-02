export const BRIDGE_CONFIGS = {
  whatsapp: {
    bridgeBot: '@whatsappbot:maunium.net',
    loginCommand: '!wa login',
    logoutCommand: '!wa logout',
    syncCommand: '!wa sync',
    qrPrefix: 'QR code:',
    successMessage: 'Successfully logged in'
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
  whatsapp: 60000,
  telegram: 30000,
  discord: 30000,
  slack: 30000
};

export const BRIDGE_EVENTS = {
  connected: 'Successfully logged in',
  disconnected: 'Logged out',
  error: 'Error:',
  qrCode: 'Please scan the following QR code:'
}; 