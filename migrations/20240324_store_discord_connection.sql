-- Create or replace the function to store Discord connections
CREATE OR REPLACE FUNCTION store_discord_connection(
  p_user_id UUID,
  p_platform_user_id TEXT,
  p_platform_username TEXT,
  p_platform_data JSONB,
  p_credentials JSONB
) RETURNS void AS $$
BEGIN
  -- Insert or update the account record
  INSERT INTO accounts (
    user_id,
    platform,
    platform_user_id,
    platform_username,
    platform_data,
    credentials,
    status,
    updated_at
  ) VALUES (
    p_user_id,
    'discord',
    p_platform_user_id,
    p_platform_username,
    p_platform_data,
    p_credentials,
    'active',
    NOW()
  )
  ON CONFLICT (user_id, platform)
  DO UPDATE SET
    platform_user_id = EXCLUDED.platform_user_id,
    platform_username = EXCLUDED.platform_username,
    platform_data = EXCLUDED.platform_data,
    credentials = EXCLUDED.credentials,
    status = EXCLUDED.status,
    updated_at = EXCLUDED.updated_at;
END;
$$ LANGUAGE plpgsql; 