create table
  public.user_onboarding (
    id uuid not null default extensions.uuid_generate_v4 (),
    user_id uuid not null,
    current_step text not null,
    is_complete boolean null default false,
    created_at timestamp with time zone null default timezone ('utc'::text, now()),
    updated_at timestamp with time zone null default timezone ('utc'::text, now()),
    constraint user_onboarding_pkey primary key (id),
    constraint user_onboarding_user_id_key unique (user_id),
    constraint user_onboarding_user_id_fkey foreign key (user_id) references auth.users (id)
  ) tablespace pg_default;

create trigger update_user_onboarding_updated_at before
update on user_onboarding for each row
execute function update_updated_at_column ();

-- Enable RLS
ALTER TABLE public.user_onboarding ENABLE ROW LEVEL SECURITY;

-- Policy for users to view their own onboarding status
CREATE POLICY "Users can view their own onboarding status"
  ON public.user_onboarding
  FOR SELECT
  USING (auth.uid() = user_id);

-- Policy for users to insert their own onboarding status
CREATE POLICY "Users can insert their own onboarding status"
  ON public.user_onboarding
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Policy for users to update their own onboarding status
CREATE POLICY "Users can update their own onboarding status"
  ON public.user_onboarding
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Policy for users to delete their own onboarding status
CREATE POLICY "Users can delete their own onboarding status"
  ON public.user_onboarding
  FOR DELETE
  USING (auth.uid() = user_id);