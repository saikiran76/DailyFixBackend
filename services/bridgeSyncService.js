// import { BRIDGE_CONFIGS } from '../config/bridgeConfig.js';
import { supabase } from '../utils/supabase.js';
import { bridges } from './matrixBridgeService.js';

export async function syncBridgeMessages(userId, platform, sourceChannelId, targetChannelId) {
  const bridge = bridges.get(`${userId}-${platform}`);
  if (!bridge) {
    throw new Error(`No active bridge found for ${platform}`);
  }

  try {
    // Get last synced message timestamp
    const { data: lastSync } = await supabase
      .from('sync_status')
      .select('last_synced')
      .eq('user_id', userId)
      .eq('platform', platform)
      .eq('channel_id', sourceChannelId)
      .single();

    const since = lastSync?.last_synced || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Fetch messages since last sync
    const { data: messages, error } = await supabase
      .from('messages')
      .select('*')
      .eq('platform', platform)
      .eq('channel_id', sourceChannelId)
      .gt('timestamp', since)
      .order('timestamp', { ascending: true });

    if (error) throw error;

    // Forward messages to Matrix room
    for (const message of messages) {
      await bridge.matrixClient.sendMessage(targetChannelId, {
        msgtype: 'm.text',
        body: message.content
      });
    }

    // Update sync status
    await supabase
      .from('sync_status')
      .upsert({
        user_id: userId,
        platform,
        channel_id: sourceChannelId,
        last_synced: new Date().toISOString()
      });

  } catch (error) {
    console.error(`Bridge sync error for ${platform}:${sourceChannelId}`, error);
    throw error;
  }
} 