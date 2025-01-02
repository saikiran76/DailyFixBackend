import { 
  initializeTelegram, 
  finalizeTelegram, 
  checkTelegramStatus, 
  disconnectTelegram 
} from './directServices/telegramDirect.js';

import { 
  initializeDiscord, 
  getDiscordStatus, 
  disconnectDiscord 
} from './directServices/discordDirect.js';

import { 
  initializeWhatsApp, 
  finalizeWhatsApp, 
  checkWhatsAppStatus, 
  disconnectWhatsApp 
} from './directServices/whatsappDirect.js';

const platformHandlers = {
  telegram: {
    initialize: initializeTelegram,
    finalize: finalizeTelegram,
    checkStatus: checkTelegramStatus,
    disconnect: disconnectTelegram
  },
  discord: {
    initialize: initializeDiscord,
    checkStatus: getDiscordStatus,
    disconnect: disconnectDiscord
  },
  whatsapp: {
    initialize: initializeWhatsApp,
    finalize: finalizeWhatsApp,
    checkStatus: checkWhatsAppStatus,
    disconnect: disconnectWhatsApp
  }
};

export const initializePlatform = async (userId, platform) => {
  const handler = platformHandlers[platform];
  if (!handler) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  return handler.initialize(userId);
};

export const checkPlatformStatus = async (userId, platform) => {
  const handler = platformHandlers[platform];
  if (!handler) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  return handler.checkStatus(userId);
};

export const disconnectPlatform = async (userId, platform) => {
  const handler = platformHandlers[platform];
  if (!handler) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  return handler.disconnect(userId);
};

export const handlePlatformError = (error, res) => {
  console.error('Platform error:', error);
  
  if (error.message.includes('No active connection')) {
    return res.status(400).json({
      status: 'error',
      message: 'No active connection found. Please start a new connection.'
    });
  }

  if (error.message.includes('already connected')) {
    return res.status(400).json({
      status: 'error',
      message: 'Platform is already connected.'
    });
  }

  return res.status(500).json({
    status: 'error',
    message: error.message || 'An unexpected error occurred'
  });
};

// Update onboarding status with proper error handling
export const updateOnboardingStatus = async (userId, connectedPlatforms) => {
  try {
    // First check if record exists
    const { data: existingRecord } = await adminClient
      .from('user_onboarding')
      .select('user_id')
      .eq('user_id', userId)
      .single();

    if (existingRecord) {
      // Update existing record
      const { error: updateError } = await adminClient
        .from('user_onboarding')
        .update({
          current_step: connectedPlatforms.length > 0 ? 'complete' : 'welcome',
          is_complete: connectedPlatforms.length > 0,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId);

      if (updateError) {
        console.error('Error updating onboarding status:', updateError);
        throw updateError;
      }
    } else {
      // Insert new record
      const { error: insertError } = await adminClient
        .from('user_onboarding')
        .insert({
          user_id: userId,
          current_step: connectedPlatforms.length > 0 ? 'complete' : 'welcome',
          is_complete: connectedPlatforms.length > 0,
          updated_at: new Date().toISOString()
        });

      if (insertError) {
        console.error('Error inserting onboarding status:', insertError);
        throw insertError;
      }
    }
  } catch (error) {
    console.error('Error managing onboarding status:', error);
    throw error;
  }
};

export const finalizePlatform = async (userId, platform, token) => {
  try {
    const handler = platformHandlers[platform];
    if (!handler) {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    // Discord uses OAuth2 and doesn't need finalization through this route
    if (platform === 'discord') {
      throw new Error('Discord uses OAuth2 flow. Please use the OAuth2 callback route.');
    }

    if (!handler.finalize) {
      throw new Error(`Platform ${platform} does not support token-based finalization`);
    }

    // Update onboarding status
    const { data: accounts } = await adminClient
      .from('accounts')
      .select('platform')
      .eq('user_id', userId)
      .eq('status', 'active');

    const connectedPlatforms = accounts?.map(acc => acc.platform) || [];
    await updateOnboardingStatus(userId, connectedPlatforms);

    return { status: 'connected' };
  } catch (error) {
    console.error(`Error finalizing ${platform}:`, error);
    throw error;
  }
}; 