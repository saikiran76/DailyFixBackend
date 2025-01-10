import { adminClient } from '../utils/supabase.js';
import { matrixWhatsAppService }  from './matrixWhatsAppService.js';
import { BRIDGE_CONFIGS } from '../config/bridgeConfig.js';

class WhatsAppEntityService {
  async getContacts(userId) {
    try {
      const { data: contacts, error } = await adminClient
        .from('whatsapp_contacts')
        .select(`
          id,
          whatsapp_id,
          display_name,
          profile_photo_url,
          sync_status,
          is_group,
          last_message_at,
          unread_count,
          metadata
        `)
        .eq('user_id', userId)
        .order('last_message_at', { ascending: false });

      if (error) throw error;
      return contacts;
    } catch (error) {
      console.error('Error fetching WhatsApp contacts:', error);
      throw error;
    }
  }

  async requestSync(userId, contactId) {
    try {
      // Verify contact belongs to user
      const { data: contact, error: contactError } = await adminClient
        .from('whatsapp_contacts')
        .select('id, whatsapp_id')
        .eq('id', contactId)
        .eq('user_id', userId)
        .single();

      if (contactError) throw contactError;
      if (!contact) throw new Error('Contact not found');

      // Create sync request
      const { data: syncRequest, error: syncError } = await adminClient
        .from('whatsapp_sync_requests')
        .upsert({
          user_id: userId,
          contact_id: contactId,
          status: 'pending',
          requested_at: new Date().toISOString()
        }, {
          onConflict: 'user_id,contact_id',
          returning: true
        })
        .single();

      if (syncError) throw syncError;

      // Get Matrix client
      const matrixClient = matrixWhatsAppService.getMatrixClient(userId);
      if (!matrixClient) {
        throw new Error('Matrix client not initialized');
      }

      // Send sync request command to bridge bot
      await matrixClient.sendMessage(BRIDGE_CONFIGS.whatsapp.bridgeBot, {
        msgtype: 'm.text',
        body: `!wa sync ${contact.whatsapp_id}`
      });

      return syncRequest;
    } catch (error) {
      console.error('Error requesting WhatsApp sync:', error);
      throw error;
    }
  }

  async getMessages(userId, contactId, limit = 50, before = null) {
    try {
      // Verify sync is approved
      const { data: syncRequest, error: syncError } = await adminClient
        .from('whatsapp_sync_requests')
        .select('status')
        .eq('user_id', userId)
        .eq('contact_id', contactId)
        .single();

      if (syncError) throw syncError;
      if (!syncRequest || syncRequest.status !== 'approved') {
        throw new Error('Sync not approved for this contact');
      }

      // Build query
      let query = adminClient
        .from('whatsapp_messages')
        .select(`
          id,
          message_id,
          content,
          sender_id,
          sender_name,
          message_type,
          timestamp,
          is_read,
          metadata
        `)
        .eq('user_id', userId)
        .eq('contact_id', contactId)
        .order('timestamp', { ascending: false })
        .limit(limit);

      if (before) {
        query = query.lt('timestamp', before);
      }

      const { data: messages, error } = await query;
      if (error) throw error;

      return messages;
    } catch (error) {
      console.error('Error fetching WhatsApp messages:', error);
      throw error;
    }
  }

  async updateSyncStatus(userId, contactId, status) {
    try {
      const { data, error } = await adminClient
        .from('whatsapp_sync_requests')
        .update({
          status,
          approved_at: status === 'approved' ? new Date().toISOString() : null
        })
        .eq('user_id', userId)
        .eq('contact_id', contactId)
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error updating sync status:', error);
      throw error;
    }
  }

  async updateUnreadCount(userId, contactId, count) {
    try {
      const { data, error } = await adminClient
        .from('whatsapp_contacts')
        .update({ unread_count: count })
        .eq('user_id', userId)
        .eq('id', contactId)
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error updating unread count:', error);
      throw error;
    }
  }

  async markMessagesAsRead(userId, contactId, messageIds) {
    try {
      const { data, error } = await adminClient
        .from('whatsapp_messages')
        .update({ is_read: true })
        .eq('user_id', userId)
        .eq('contact_id', contactId)
        .in('message_id', messageIds);

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error marking messages as read:', error);
      throw error;
    }
  }
}

export const whatsappEntityService = new WhatsAppEntityService(); 