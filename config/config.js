import dotenv from 'dotenv';
dotenv.config();

export const config = {
  encryptionKey: process.env.ENCRYPTION_KEY || 'default-32-char-encryption-key-here', // Must be 32 bytes
  server: {
    port: process.env.PORT || 3001,
    host: process.env.HOST || 'localhost'
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    serviceKey: process.env.SUPABASE_SERVICE_KEY
  },
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET
  }
}; 