create table
  public.accounts (
    id uuid not null default extensions.uuid_generate_v4 (),
    user_id uuid null,
    platform public.platform_type not null,
    credentials jsonb not null default '{}'::jsonb,
    status public.account_status null default 'pending'::account_status,
    connected_at timestamp with time zone null,
    created_at timestamp with time zone null default now(),
    updated_at timestamp with time zone null default now(),
    platform_user_id text null,
    platform_username text null,
    platform_data jsonb null default '{}'::jsonb,
    refresh_token text null,
    webhook_id text null,
    webhook_token text null,
    last_message_id text null,
    channels_config jsonb null default '{}'::jsonb,
    last_token_refresh timestamp without time zone null,
    metadata jsonb null default '{}'::jsonb,
    constraint accounts_pkey primary key (id),
    constraint accounts_user_id_platform_key unique (user_id, platform),
    constraint unique_webhook_per_account unique (platform, webhook_id),
    constraint accounts_user_id_fkey foreign key (user_id) references auth.users (id) on delete cascade,
    constraint valid_credentials check ((jsonb_typeof(credentials) = 'object'::text))
  ) tablespace pg_default;

create index if not exists idx_accounts_user_id on public.accounts using btree (user_id) tablespace pg_default;

create index if not exists idx_accounts_platform on public.accounts using btree (platform) tablespace pg_default;

create index if not exists idx_accounts_user_platform on public.accounts using btree (user_id, platform) tablespace pg_default;

create index if not exists idx_accounts_platform_user_id on public.accounts using btree (platform_user_id) tablespace pg_default;

create trigger update_accounts_updated_at before
update on accounts for each row
execute function update_updated_at_column ();