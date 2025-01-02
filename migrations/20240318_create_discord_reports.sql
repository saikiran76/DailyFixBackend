-- Create discord_reports table
CREATE TABLE IF NOT EXISTS public.discord_reports (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  report_data JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, server_id, report_id)
);

-- Add indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_discord_reports_user_id ON public.discord_reports(user_id);
CREATE INDEX IF NOT EXISTS idx_discord_reports_server_id ON public.discord_reports(server_id);
CREATE INDEX IF NOT EXISTS idx_discord_reports_report_id ON public.discord_reports(report_id);
CREATE INDEX IF NOT EXISTS idx_discord_reports_created_at ON public.discord_reports(created_at); 