import { Server } from 'socket.io';
import { adminClient } from '../utils/supabase.js';
import { ioEmitter } from '../utils/emitter.js';
import { validateDiscordToken, refreshDiscordToken } from './directServices/discordDirect.js';

export function initializeSocketServer(server) {
  const io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL || 'http://localhost:5173',
      credentials: true,
      methods: ['GET', 'POST']
    },
    pingTimeout: 60000,
    pingInterval: 25000
  });

  // Socket authentication middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) {
        throw new Error('Authentication token required');
      }

      // Verify token with Supabase
      const { data: { user }, error } = await adminClient.auth.getUser(token);
      
      if (error || !user) {
        throw new Error('Invalid authentication token');
      }

      // Get Discord account status
      const { data: account } = await adminClient
        .from('accounts')
        .select('credentials, status')
        .eq('user_id', user.id)
        .eq('platform', 'discord')
        .single();

      if (!account) {
        // No Discord account, allow connection but mark as inactive
        socket.user = user;
        socket.discordStatus = 'inactive';
        next();
        return;
      }

      if (account.status === 'active') {
        // Validate Discord token
        const isValid = await validateDiscordToken(user.id);
        if (!isValid) {
          // Try refreshing token
          try {
            await refreshDiscordToken(user.id);
            const retryValid = await validateDiscordToken(user.id);
            if (!retryValid) {
              socket.user = user;
              socket.discordStatus = 'inactive';
              next();
              return;
            }
          } catch (refreshError) {
            console.error('Token refresh failed:', refreshError);
            socket.user = user;
            socket.discordStatus = 'inactive';
            next();
            return;
          }
        }
        socket.discordStatus = 'active';
      } else {
        socket.discordStatus = account.status;
      }

      socket.user = user;
      next();
    } catch (error) {
      console.error('Socket authentication error:', error);
      next(new Error('Authentication failed: ' + error.message));
    }
  });

  io.on('connection', (socket) => {
    console.log('Client connected:', socket.user.id, 'Discord status:', socket.discordStatus);
    let heartbeatTimeout;

    // Join user's room for private messages
    socket.join(`user:${socket.user.id}`);

    // Emit initial status
    socket.emit('discord_status', {
      userId: socket.user.id,
      status: socket.discordStatus,
      timestamp: Date.now()
    });

    // Handle heartbeat with status check
    socket.on('ping', async () => {
      clearTimeout(heartbeatTimeout);
      
      // Check Discord status on each ping
      if (socket.discordStatus === 'active') {
        const isValid = await validateDiscordToken(socket.user.id);
        if (!isValid) {
          try {
            await refreshDiscordToken(socket.user.id);
            const retryValid = await validateDiscordToken(socket.user.id);
            if (!retryValid) {
              socket.discordStatus = 'inactive';
              socket.emit('discord_status', {
                userId: socket.user.id,
                status: 'inactive',
                timestamp: Date.now()
              });
            }
          } catch (error) {
            console.error('Token refresh failed during heartbeat:', error);
            socket.discordStatus = 'inactive';
            socket.emit('discord_status', {
              userId: socket.user.id,
              status: 'inactive',
              timestamp: Date.now()
            });
          }
        }
      }
      
      socket.emit('pong');
      
      // Set timeout to disconnect if no ping received
      heartbeatTimeout = setTimeout(() => {
        console.log('Client heartbeat timeout:', socket.user.id);
        socket.disconnect(true);
      }, 65000); // Slightly longer than client's interval
    });

    // Handle re-authentication with better error handling
    socket.on('authenticate', async ({ token }) => {
      try {
        const { data: { user }, error } = await adminClient.auth.getUser(token);
        if (error || !user) {
          socket.emit('auth_error', { message: 'Invalid token' });
          return;
        }

        // Get Discord account status
        const { data: account } = await adminClient
          .from('accounts')
          .select('credentials, status')
          .eq('user_id', user.id)
          .eq('platform', 'discord')
          .single();

        if (!account) {
          socket.user = user;
          socket.discordStatus = 'inactive';
          socket.emit('auth_success');
          socket.emit('discord_status', {
            userId: user.id,
            status: 'inactive',
            timestamp: Date.now()
          });
          return;
        }

        if (account.status === 'active') {
          const isValid = await validateDiscordToken(user.id);
          if (!isValid) {
            try {
              await refreshDiscordToken(user.id);
              const retryValid = await validateDiscordToken(user.id);
              if (!retryValid) {
                socket.discordStatus = 'inactive';
                socket.emit('discord_status', {
                  userId: user.id,
                  status: 'inactive',
                  timestamp: Date.now()
                });
              } else {
                socket.discordStatus = 'active';
              }
            } catch (refreshError) {
              socket.discordStatus = 'inactive';
              socket.emit('discord_status', {
                userId: user.id,
                status: 'inactive',
                timestamp: Date.now()
              });
            }
          } else {
            socket.discordStatus = 'active';
          }
        } else {
          socket.discordStatus = account.status;
        }

        socket.user = user;
        socket.emit('auth_success');
        socket.emit('discord_status', {
          userId: user.id,
          status: socket.discordStatus,
          timestamp: Date.now()
        });
      } catch (error) {
        console.error('Authentication error:', error);
        socket.emit('auth_error', { message: error.message });
      }
    });

    // Listen for Discord events from the emitter
    const discordMessageHandler = (data) => {
      if (data.userId === socket.user.id) {
        socket.emit('discord_message', data);
      }
    };

    const discordStatusHandler = (data) => {
      if (data.userId === socket.user.id) {
        socket.emit('discord_status', data);
      }
    };

    ioEmitter.on('discord_message', discordMessageHandler);
    ioEmitter.on('discord_status', discordStatusHandler);

    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.user.id);
      clearTimeout(heartbeatTimeout);
      
      // Clean up event listeners
      ioEmitter.removeListener('discord_message', discordMessageHandler);
      ioEmitter.removeListener('discord_status', discordStatusHandler);
    });

    // Initial heartbeat
    socket.emit('pong');
  });

  return io;
} 