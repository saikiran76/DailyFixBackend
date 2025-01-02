import { adminClient } from '../../utils/supabase.js';
import axios from 'axios';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { ioEmitter } from '../../utils/emitter.js';
import PDFDocument from 'pdfkit';

const DISCORD_API_URL = 'https://discord.com/api/v10';

class ConnectionManager {
  #connections = new Map();
  #gatewayClients = new Map();

  async initialize(userId) {
    console.log(`Initializing Discord for user ${userId}`);
    
    // Check if already connected
    const { data: account } = await adminClient
        .from('accounts')
      .select('status')
        .eq('user_id', userId)
      .eq('platform', 'discord')
      .single();

    if (account?.status === 'active') {
      return {
        status: 'active',
        message: 'Discord connection is active'
      };
    }

    return {
      status: 'inactive',
      message: 'Discord connection requires authorization',
      requiresAuth: true
    };
  }

  async #initializeGatewayClient(userId, token) {
    try {
      // Check for existing client
      const existingClient = this.#gatewayClients.get(userId);
      if (existingClient) {
        if (existingClient.isReady()) {
          console.log(`Reusing existing gateway client for user ${userId}`);
          return existingClient;
        }
        // Destroy non-ready client
        await existingClient.destroy();
        this.#gatewayClients.delete(userId);
      }

      // Get account credentials
      const { data: account } = await adminClient
        .from('accounts')
        .select('credentials, status')
        .eq('user_id', userId)
        .eq('platform', 'discord')
        .single();

      if (!account?.credentials?.access_token) {
        throw new Error('No Discord access token found');
      }

      // Create new Discord.js client with necessary intents
      const client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Channel, Partials.Message],
        retryLimit: 5,
        presence: {
          status: 'online'
        }
      });

      // Set up event handlers
      client.on('ready', () => {
        console.log(`Gateway client ready for user ${userId}`);
        ioEmitter.emit('discord_status', {
          userId,
          status: 'active',
          timestamp: Date.now(),
          guilds: client.guilds.cache.size
        });

        // Update account status to active
        adminClient
          .from('accounts')
          .update({
            status: 'active',
            updated_at: new Date().toISOString()
          })
          .eq('user_id', userId)
          .eq('platform', 'discord')
          .then(() => {
            console.log(`Updated Discord account status to active for user ${userId}`);
          })
          .catch(error => {
            console.error(`Failed to update Discord account status for user ${userId}:`, error);
          });
      });

      client.on('error', async (error) => {
        console.error(`Gateway client error for user ${userId}:`, error);
        
        // Update account status to inactive on error
        await adminClient
          .from('accounts')
          .update({
            status: 'inactive',
            updated_at: new Date().toISOString()
          })
          .eq('user_id', userId)
          .eq('platform', 'discord');

        ioEmitter.emit('discord_status', {
          userId,
          status: 'inactive',
          error: error.message,
          timestamp: Date.now()
        });
      });

      // Add disconnect handler with reconnection logic
      client.on('disconnect', async (event) => {
        console.log(`Gateway client disconnected for user ${userId}:`, event);
        
        try {
          // Check token validity
          const isValid = await this.validateAndRefreshToken(userId);
          if (!isValid) {
            throw new Error('Token validation failed during reconnection');
          }

          // Attempt to reconnect
          if (!client.isReady()) {
            await client.login(process.env.DISCORD_BOT_TOKEN);
          }
        } catch (error) {
          console.error(`Failed to reconnect gateway client for ${userId}:`, error);
          
          // Update account status to inactive
          await adminClient
            .from('accounts')
            .update({
              status: 'inactive',
              updated_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .eq('platform', 'discord');

          // Emit error status
          ioEmitter.emit('discord_status', {
            userId,
            status: 'inactive',
            error: error.message,
            timestamp: Date.now()
          });
        }
      });

      // Login with bot token
      await client.login(process.env.DISCORD_BOT_TOKEN);
      this.#gatewayClients.set(userId, client);

      return client;
    } catch (error) {
      console.error(`Error initializing gateway client for ${userId}:`, error);
      throw error;
    }
  }

  async getServers(userId) {
    try {
        const { data: account } = await adminClient
            .from('accounts')
            .select('credentials, status, channels_config')
            .eq('user_id', userId)
            .eq('platform', 'discord')
            .single();

        if (!account) {
            throw new Error('No Discord account found');
        }

        if (account.status !== 'active') {
            throw new Error('Discord account is not active');
        }

        // Try to use cached data first
        if (account?.channels_config?.servers?.length > 0) {
            console.log('Using cached server data');
            return {
                status: 'success',
                data: account.channels_config.servers,
                meta: {
                    total: account.channels_config.servers.length,
                    hasMore: false
                }
            };
        }

        // Validate and refresh token if needed
        const isValid = await this.validateAndRefreshToken(userId);
        if (!isValid) {
            throw new Error('Failed to validate Discord token');
        }

        // Get latest token after validation
        const latestToken = await this.getLatestToken(userId);
        
        // Get servers (guilds) from Discord API
        const response = await fetch(`${DISCORD_API_URL}/users/@me/guilds`, {
            headers: {
                Authorization: `Bearer ${latestToken.access_token}`
            }
        });

        if (!response.ok) {
            if (response.status === 429) {
                const retryAfter = parseInt(response.headers.get('Retry-After') || '5', 10);
                console.log(`Rate limited, retrying after ${retryAfter} seconds`);
                await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                return this.getServers(userId);
            }
            throw new Error(`Failed to fetch Discord servers: ${response.status}`);
        }

        const servers = await response.json();

        // Format servers for frontend
        const formattedServers = servers.map(server => ({
            id: server.id,
            name: server.name,
            icon: server.icon,
            owner: server.owner,
            permissions: server.permissions,
            features: server.features
        }));

        // Store server information in channels_config
        const updatedChannelsConfig = {
            ...(account.channels_config || {}),
            servers: formattedServers
        };

        // Update account with server information
        await adminClient
            .from('accounts')
            .update({
                channels_config: updatedChannelsConfig,
                updated_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .eq('platform', 'discord');

        return {
            status: 'success',
            data: formattedServers,
            meta: {
                total: formattedServers.length,
                hasMore: false
            }
        };
    } catch (error) {
        console.error(`Error fetching Discord servers for ${userId}:`, error);
        throw {
            status: 'error',
            message: error.message,
            details: error.toString()
        };
    }
  }

  async getChannels(userId, serverId) {
    try {
      // Validate token first
      const isValid = await this.validateAndRefreshToken(userId);
      if (!isValid) {
        throw new Error('Discord token validation failed');
      }

      const { data: account } = await adminClient
        .from('accounts')
        .select('credentials, channels_config')
        .eq('user_id', userId)
        .eq('platform', 'discord')
        .single();

      if (!account?.credentials?.access_token) {
        throw new Error('No Discord access token found');
      }

      // Get channels from Discord API
      const response = await fetch(`${DISCORD_API_URL}/guilds/${serverId}/channels`, {
        headers: {
          Authorization: `Bearer ${account.credentials.access_token}`
        }
      });

      if (!response.ok) {
        if (response.status === 401) {
          await this.refreshToken(userId);
          return this.getChannels(userId, serverId);
        }

        // Handle rate limiting
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('Retry-After') || '5', 10);
          console.log(`Rate limited, retrying after ${retryAfter} seconds`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          return this.getChannels(userId, serverId);
        }

        throw new Error('Failed to fetch Discord channels');
      }

      const channels = await response.json();

      // Store channel information in channels_config
      const updatedChannelsConfig = {
        ...(account.channels_config || {}),
        [`server_${serverId}_channels`]: channels.map(channel => ({
          id: channel.id,
          name: channel.name,
          type: channel.type,
          position: channel.position,
          parent_id: channel.parent_id,
          updated_at: new Date().toISOString()
        }))
      };

      // Update account with channel information
      await adminClient
        .from('accounts')
        .update({
          channels_config: updatedChannelsConfig,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('platform', 'discord');

      return channels;
    } catch (error) {
      console.error(`Error fetching Discord channels for ${userId}:`, error);
      
      // Try to return cached data from channels_config
      try {
        const { data: account } = await adminClient
          .from('accounts')
          .select('channels_config')
          .eq('user_id', userId)
          .eq('platform', 'discord')
          .single();

        if (account?.channels_config?.[`server_${serverId}_channels`]?.length > 0) {
          console.log('Returning cached channel data');
          return account.channels_config[`server_${serverId}_channels`];
        }
      } catch (cacheError) {
        console.error('Cache retrieval failed:', cacheError);
      }
      
      throw error;
    }
  }

  async getDirectMessages(userId) {
    try {
        // Get account with credentials
        const { data: account } = await adminClient
            .from('accounts')
            .select('credentials, status, channels_config')
            .eq('user_id', userId)
            .eq('platform', 'discord')
            .single();

        if (!account) {
            throw new Error('No Discord account found');
        }

        if (account.status !== 'active') {
            throw new Error('Discord account is not active');
        }

        // Try to use cached data first if available and not expired
        if (account?.channels_config?.direct_messages?.length > 0 && 
            account?.channels_config?.dm_cache_timestamp && 
            (Date.now() - new Date(account.channels_config.dm_cache_timestamp).getTime() < 300000)) {
            console.log('Using cached DM data');
            return {
                status: 'success',
                data: account.channels_config.direct_messages,
                meta: {
                    total: account.channels_config.direct_messages.length,
                    hasMore: false,
                    cached: true
                }
            };
        }

        // Initialize Discord.js client if needed
        const client = await this.#initializeGatewayClient(userId);
        if (!client || !client.isReady()) {
            throw new Error('Discord client not ready');
        }

        // Get DM channels using Discord.js client
        const dmChannels = await client.channels.cache
            .filter(channel => channel.type === 1) // 1 is DM channel type
            .map(channel => ({
                id: channel.id,
                name: channel.recipient?.username || 'Direct Message',
                icon: channel.recipient?.avatar || null,
                type: channel.type,
                owner: false,
                permissions: '0',
                features: []
            }));

        // Store DM information in channels_config with timestamp
        const updatedChannelsConfig = {
            ...(account.channels_config || {}),
            direct_messages: dmChannels,
            dm_cache_timestamp: new Date().toISOString()
        };

        // Update account with DM information
        await adminClient
            .from('accounts')
            .update({
                channels_config: updatedChannelsConfig,
                updated_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .eq('platform', 'discord');

        return {
            status: 'success',
            data: dmChannels,
            meta: {
                total: dmChannels.length,
                hasMore: false,
                cached: false
            }
        };
    } catch (error) {
        console.error(`Error fetching Discord DMs for ${userId}:`, error);
        throw {
            status: 'error',
            message: error.message || 'Failed to fetch Discord DMs',
            details: error.toString()
        };
    }
  }

  async refreshToken(userId) {
    try {
        const { data: account } = await adminClient
            .from('accounts')
            .select('credentials, status')
            .eq('user_id', userId)
            .eq('platform', 'discord')
            .single();

        if (!account?.credentials?.refresh_token) {
            throw new Error('No refresh token found');
        }

        console.log('Attempting token refresh:', {
            userId,
            timestamp: new Date().toISOString()
        });

        const response = await fetch(`${DISCORD_API_URL}/oauth2/token`, {
            method: 'POST',
            body: new URLSearchParams({
                client_id: process.env.DISCORD_CLIENT_ID,
                client_secret: process.env.DISCORD_CLIENT_SECRET,
                grant_type: 'refresh_token',
                refresh_token: account.credentials.refresh_token
            }),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('Discord token refresh failed:', {
                status: response.status,
                error: errorData
            });

            if (response.status === 400 && errorData.error === 'invalid_grant') {
                await this.disconnect(userId);
                throw new Error('Discord connection expired. Please reconnect.');
            }

            throw new Error(`Failed to refresh token: ${response.status}`);
        }

        const tokenData = await response.json();
        const now = new Date();

        // Update tokens in database
        const { error: updateError } = await adminClient
            .from('accounts')
            .update({
                credentials: {
                    access_token: tokenData.access_token,
                    refresh_token: tokenData.refresh_token,
                    token_type: tokenData.token_type,
                    scope: tokenData.scope,
                    expires_in: tokenData.expires_in,
                    refreshed_at: now.toISOString(),
                    expires_at: new Date(now.getTime() + (tokenData.expires_in * 1000)).getTime(),
                    created_at: account.credentials.created_at || now.toISOString()
                },
                status: 'active',
                updated_at: now.toISOString(),
                last_token_refresh: now.toISOString()
            })
            .eq('user_id', userId)
            .eq('platform', 'discord');

        if (updateError) {
            console.error('Failed to update account with new tokens:', updateError);
            throw updateError;
        }

        console.log('Token refresh successful:', {
            userId,
            expiresIn: tokenData.expires_in
        });

        return tokenData;
    } catch (error) {
        console.error('Error in refreshToken:', error);
        throw error;
    }
  }

  async validateAndRefreshToken(userId) {
    try {
      const { data: account } = await adminClient
        .from('accounts')
        .select('credentials, status')
        .eq('user_id', userId)
        .eq('platform', 'discord')
        .single();

      if (!account) {
        console.error('No Discord account found for validation');
        return false;
      }

      if (!account?.credentials?.access_token) {
        console.error('No access token found for validation');
        return false;
      }

      // Get latest token state
      const latestToken = await this.getLatestToken(userId);
      
      // Always verify with Discord API first
      const verifyResponse = await fetch(`${DISCORD_API_URL}/users/@me`, {
        headers: {
          Authorization: `Bearer ${latestToken.access_token}`
        }
      });

      if (!verifyResponse.ok) {
        console.log('Token invalid, attempting refresh');
        try {
          const refreshedToken = await this.refreshToken(userId);
          if (!refreshedToken) {
            throw new Error('Token refresh failed');
          }

          // Verify the refreshed token
          const retryResponse = await fetch(`${DISCORD_API_URL}/users/@me`, {
            headers: {
              Authorization: `Bearer ${refreshedToken.access_token}`
            }
          });

          if (!retryResponse.ok) {
            throw new Error('Token still invalid after refresh');
          }

          // Update account status to active
          await adminClient
            .from('accounts')
            .update({
              status: 'active',
              updated_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .eq('platform', 'discord');

          return true;
        } catch (error) {
          console.error('Token refresh failed:', error);
          
          // Update account status to inactive
          await adminClient
            .from('accounts')
            .update({
              status: 'inactive',
              updated_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .eq('platform', 'discord');
          
          return false;
        }
      }

      // Token is valid, ensure status is active
      if (account.status !== 'active') {
        await adminClient
          .from('accounts')
          .update({
            status: 'active',
            updated_at: new Date().toISOString()
          })
          .eq('user_id', userId)
          .eq('platform', 'discord');
      }

      return true;
    } catch (error) {
      console.error('Error in validateAndRefreshToken:', error);
      return false;
    }
  }

  // Helper method to get the latest token
  async getLatestToken(userId) {
    const { data: account } = await adminClient
        .from('accounts')
        .select('credentials')
        .eq('user_id', userId)
        .eq('platform', 'discord')
        .single();
    
    if (!account?.credentials?.access_token) {
        throw new Error('No access token found');
    }
    
    return account.credentials;
  }

  async disconnect(userId) {
    try {
      // Destroy gateway client if exists
      const client = this.#gatewayClients.get(userId);
      if (client) {
        await client.destroy();
        this.#gatewayClients.delete(userId);
      }

      const { data: account } = await adminClient
        .from('accounts')
        .select('credentials')
        .eq('user_id', userId)
        .eq('platform', 'discord')
        .single();

      if (account?.credentials?.access_token) {
        // Revoke the token
        await fetch(`${DISCORD_API_URL}/oauth2/token/revoke`, {
          method: 'POST',
          body: new URLSearchParams({
            token: account.credentials.access_token,
            token_type_hint: 'access_token',
            client_id: process.env.DISCORD_CLIENT_ID,
            client_secret: process.env.DISCORD_CLIENT_SECRET
          }),
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        });
      }

      // Remove from database
      await adminClient
        .from('accounts')
        .delete()
        .eq('user_id', userId)
        .eq('platform', 'discord');

      return { status: 'disconnected' };
    } catch (error) {
      console.error(`Error disconnecting Discord for ${userId}:`, error);
      throw error;
    }
  }

  async getStatus(userId) {
    try {
      const { data: account } = await adminClient
        .from('accounts')
        .select('credentials, status')
        .eq('user_id', userId)
        .eq('platform', 'discord')
        .single();

      if (!account) {
        return { 
          status: 'inactive',
          message: 'No Discord account found'
        };
      }

      // Validate token if account exists
      const isValid = await this.validateAndRefreshToken(userId);
      
      return {
        status: isValid ? 'active' : 'inactive',
        message: isValid ? 'Discord connection is active' : 'Discord connection needs refresh',
        username: account.platform_username,
        needsRefresh: !isValid
      };
    } catch (error) {
      console.error(`Error checking Discord status for ${userId}:`, error);
      return { 
        status: 'inactive',
        message: error.message,
        error: error.message 
      };
    }
  }

  async getMessages(userId, channelId) {
    try {
      const { data: account } = await adminClient
        .from('accounts')
        .select('credentials')
        .eq('user_id', userId)
        .eq('platform', 'discord')
        .single();

      if (!account?.credentials?.access_token) {
        throw new Error('No Discord access token found');
      }

      // Get messages from Discord API
      const response = await fetch(`${DISCORD_API_URL}/channels/${channelId}/messages?limit=50`, {
        headers: {
          Authorization: `Bearer ${account.credentials.access_token}`
        }
      });

      if (!response.ok) {
        if (response.status === 401) {
          await this.refreshToken(userId);
          return this.getMessages(userId, channelId);
        }
        throw new Error('Failed to fetch Discord messages');
      }

      const messages = await response.json();
      return messages;
    } catch (error) {
      console.error(`Error fetching Discord messages for ${userId}:`, error);
      throw error;
    }
  }

  async finalize(userId, params) {
    try {
      // Extract code from params
      const code = params?.code;
      if (!code) {
        throw new Error('No authorization code provided');
      }

      // Exchange code for token
      const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', 
        new URLSearchParams({
          client_id: process.env.DISCORD_CLIENT_ID,
          client_secret: process.env.DISCORD_CLIENT_SECRET,
          code: code,
          grant_type: 'authorization_code',
          redirect_uri: process.env.DISCORD_REDIRECT_URI,
        }), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        });

      const { access_token, refresh_token, token_type, scope, expires_in } = tokenResponse.data;

      // Get user data
      const userResponse = await axios.get('https://discord.com/api/users/@me', {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      });

      const discordUser = userResponse.data;
      console.log('Discord user data:', discordUser);

      // Store in database with enhanced metadata
      const { error: upsertError } = await adminClient
        .from('accounts')
        .upsert({
          user_id: userId,
          platform: 'discord',
          platform_user_id: discordUser.id,
          platform_username: discordUser.username,
          platform_data: {
            global_name: discordUser.global_name,
            avatar: discordUser.avatar,
            discriminator: discordUser.discriminator
          },
          credentials: {
            access_token,
            refresh_token,
            token_type,
            scope,
            expires_in,
            expires_at: Date.now() + (expires_in * 1000),
            created_at: new Date().toISOString()
          },
          status: 'active',
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'user_id,platform'
        });

      if (upsertError) throw upsertError;

      // Validate token before proceeding
      const isValid = await this.validateAndRefreshToken(userId);
      if (!isValid) {
        throw new Error('Failed to validate Discord connection');
      }

      // Update onboarding status directly
      const { error: onboardingError } = await adminClient
        .from('user_onboarding')
        .upsert({
          user_id: userId,
          is_complete: true,
          current_step: 'complete',
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'user_id'
        });

      if (onboardingError) {
        console.error('Error updating onboarding status:', onboardingError);
      }

      // Initialize gateway client for real-time updates
      await this.#initializeGatewayClient(userId, access_token);

      return {
        platform_username: discordUser.username,
        global_name: discordUser.global_name,
        status: 'active'
      };
    } catch (error) {
      console.error('Error finalizing Discord connection:', error);
      if (error.response?.data) {
        throw new Error(`Discord API error: ${error.response.data.message}`);
      }
      throw error;
    }
  }

  async getServer(userId, serverId) {
    try {
      const { data: account } = await adminClient
        .from('accounts')
        .select('credentials')
        .eq('user_id', userId)
        .eq('platform', 'discord')
        .single();

      if (!account?.credentials?.access_token) {
        throw new Error('No Discord access token found');
      }

      // Get server details from Discord API
      const response = await fetch(`${DISCORD_API_URL}/guilds/${serverId}`, {
        headers: {
          Authorization: `Bearer ${account.credentials.access_token}`
        }
      });

      if (!response.ok) {
        if (response.status === 401) {
          await this.refreshToken(userId);
          return this.getServer(userId, serverId);
        }
        throw new Error('Failed to fetch Discord server');
      }

      const server = await response.json();
      return server;
  } catch (error) {
      console.error(`Error fetching Discord server for ${userId}:`, error);
      throw error;
    }
  }

  async generateReport(userId, serverId, channelIds) {
    try {
      const { data: account } = await adminClient
        .from('accounts')
        .select('credentials')
        .eq('user_id', userId)
        .eq('platform', 'discord')
        .single();

      if (!account?.credentials?.access_token) {
        throw new Error('No Discord access token found');
      }

      // Fetch messages from each channel
      const channelMessages = await Promise.all(
        channelIds.map(async (channelId) => {
          const messages = await this.getMessages(userId, channelId);
          return { channelId, messages };
        })
      );

      // Generate report using AI
      const reportData = {
        id: Date.now().toString(), // Simple report ID for now
        serverId,
        generatedAt: new Date().toISOString(),
        summary: 'Generated summary of the conversation...', // This will be replaced with actual AI-generated summary
        channels: await Promise.all(
          channelMessages.map(async ({ channelId, messages }) => {
            const channel = await this.getChannel(userId, channelId);
            return {
              id: channelId,
              name: channel.name,
              keyPoints: ['Key point 1', 'Key point 2'], // Will be replaced with AI-generated points
              actionItems: ['Action 1', 'Action 2'] // Will be replaced with AI-generated actions
            };
          })
        )
      };

      // Store report in database
      const { error } = await adminClient
        .from('discord_reports')
        .insert({
          user_id: userId,
          server_id: serverId,
          report_id: reportData.id,
          report_data: reportData,
          created_at: reportData.generatedAt
        });

      if (error) throw error;

      return reportData;
    } catch (error) {
      console.error(`Error generating report for ${userId}:`, error);
      throw error;
    }
  }

  async getReport(userId, serverId, reportId) {
    try {
      const { data: report, error } = await adminClient
        .from('discord_reports')
        .select('report_data')
        .eq('user_id', userId)
        .eq('server_id', serverId)
        .eq('report_id', reportId)
        .single();

      if (error) throw error;
      if (!report) throw new Error('Report not found');

      return report.report_data;
    } catch (error) {
      console.error(`Error fetching report for ${userId}:`, error);
      throw error;
    }
  }

  async generateReportPDF(userId, serverId, reportId) {
    try {
      const report = await this.getReport(userId, serverId, reportId);
      const server = await this.getServer(userId, serverId);

      // Create PDF document
      const doc = new PDFDocument();
      const chunks = [];

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => {});

      // Add content to PDF
      doc.fontSize(24).text(server.name, { align: 'center' });
      doc.moveDown();
      doc.fontSize(14).text(`Report generated on ${new Date(report.generatedAt).toLocaleString()}`);
      doc.moveDown();

      // Summary section
      doc.fontSize(18).text('Summary');
      doc.moveDown();
      doc.fontSize(12).text(report.summary);
      doc.moveDown();

      // Channel sections
      for (const channel of report.channels) {
        doc.fontSize(16).text(`#${channel.name}`);
        doc.moveDown();

        doc.fontSize(14).text('Key Points');
        doc.moveDown();
        channel.keyPoints.forEach(point => {
          doc.fontSize(12).text(`• ${point}`);
        });
        doc.moveDown();

        if (channel.actionItems.length > 0) {
          doc.fontSize(14).text('Action Items');
          doc.moveDown();
          channel.actionItems.forEach(item => {
            doc.fontSize(12).text(`• ${item}`);
          });
          doc.moveDown();
        }
      }

      doc.end();

      return Buffer.concat(chunks);
    } catch (error) {
      console.error(`Error generating PDF for ${userId}:`, error);
    throw error;
    }
  }

  async getChannel(userId, channelId) {
  try {
    const { data: account } = await adminClient
      .from('accounts')
        .select('credentials')
      .eq('user_id', userId)
      .eq('platform', 'discord')
      .single();

      if (!account?.credentials?.access_token) {
        throw new Error('No Discord access token found');
      }

      // Get channel details from Discord API
      const response = await fetch(`${DISCORD_API_URL}/channels/${channelId}`, {
        headers: {
          Authorization: `Bearer ${account.credentials.access_token}`
        }
      });

      if (!response.ok) {
        if (response.status === 401) {
          await this.refreshToken(userId);
          return this.getChannel(userId, channelId);
        }
        throw new Error('Failed to fetch Discord channel');
      }

      const channel = await response.json();
      return channel;
  } catch (error) {
      console.error(`Error fetching Discord channel for ${userId}:`, error);
    throw error;
  }
  }

  getClient(userId) {
    return this.#gatewayClients.get(userId);
  }
}

// Export singleton instance
const connectionManager = new ConnectionManager();

export const initializeDiscord = (userId) => connectionManager.initialize(userId);
export const finalizeDiscord = (userId, params) => connectionManager.finalize(userId, params);
export const getDiscordGuilds = (userId) => connectionManager.getServers(userId);
export const disconnectDiscord = (userId) => connectionManager.disconnect(userId);
export const getDiscordStatus = (userId) => connectionManager.getStatus(userId);
export const getDiscordServers = (userId) => connectionManager.getServers(userId);
export const getDiscordChannels = (userId, serverId) => connectionManager.getChannels(userId, serverId);
export const getDiscordDirectMessages = (userId) => connectionManager.getDirectMessages(userId);
export const getDiscordClient = (userId) => connectionManager.getClient(userId);
export const getDiscordMessages = (userId, channelId) => connectionManager.getMessages(userId, channelId);
export const validateDiscordToken = (userId) => connectionManager.validateAndRefreshToken(userId);
export const refreshDiscordToken = (userId) => connectionManager.refreshToken(userId); 