import { adminClient } from '../utils/supabase.js';
import { matrixWhatsAppService } from './matrixWhatsAppService.js';

class SyncJobService {
  constructor() {
    this.isRunning = false;
    this.syncInterval = 5 * 60 * 1000; // 5 minutes
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    
    console.log('Starting WhatsApp sync job service');
    this.scheduleNextRun();
  }

  async stop() {
    this.isRunning = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }
  }

  scheduleNextRun() {
    if (!this.isRunning) return;
    
    this.timeoutId = setTimeout(async () => {
      await this.processPendingSyncs();
      this.scheduleNextRun();
    }, this.syncInterval);
  }

  async processPendingSyncs() {
    try {
      console.log('Processing pending WhatsApp syncs...');

      // Get all pending sync requests
      const { data: pendingSyncs, error: fetchError } = await adminClient
        .from('whatsapp_sync_requests')
        .select(`
          id,
          user_id,
          contact_id,
          requested_at
        `)
        .eq('status', 'pending')
        .order('requested_at', { ascending: true });

      if (fetchError) {
        console.error('Error fetching pending syncs:', fetchError);
        return;
      }

      if (!pendingSyncs || pendingSyncs.length === 0) {
        console.log('No pending syncs found');
        return;
      }

      console.log(`Found ${pendingSyncs.length} pending syncs`);

      // Process each sync request
      for (const sync of pendingSyncs) {
        try {
          console.log(`Processing sync for user ${sync.user_id}, contact ${sync.contact_id}`);
          
          await matrixWhatsAppService.syncMessages(sync.user_id, sync.contact_id);
          
          console.log(`Sync completed for user ${sync.user_id}, contact ${sync.contact_id}`);
        } catch (error) {
          console.error(`Error processing sync ${sync.id}:`, error);
          
          // Update sync request status on error
          await adminClient
            .from('whatsapp_sync_requests')
            .update({
              status: 'rejected',
              metadata: {
                error: error.message,
                failed_at: new Date().toISOString()
              }
            })
            .eq('id', sync.id);
        }
      }

    } catch (error) {
      console.error('Error in sync job:', error);
    }
  }
}

export const syncJobService = new SyncJobService();