create table
  public.whatsapp_contacts (
    id serial not null,
    user_id uuid not null,
    whatsapp_id text not null,
    display_name text null,
    profile_photo_url text null,
    sync_status text null default 'pending'::text,
    is_group boolean null default false,
    last_message_at timestamp with time zone null,
    unread_count integer null default 0,
    metadata jsonb null default '{}'::jsonb,
    created_at timestamp with time zone null default now(),
    updated_at timestamp with time zone null default now(),
    bridge_room_id text null,
    priority public.priority_level null,
    last_analysis_at timestamp with time zone null,
    constraint whatsapp_contacts_pkey primary key (id),
    constraint whatsapp_contacts_user_id_whatsapp_id_key unique (user_id, whatsapp_id),
    constraint whatsapp_contacts_user_id_fkey foreign key (user_id) references auth.users (id),
    constraint whatsapp_contacts_sync_status_check check (
      (
        sync_status = any (
          array[
            'pending'::text,
            'approved'::text,
            'rejected'::text
          ]
        )
      )
    )
  ) tablespace pg_default;

create index if not exists idx_whatsapp_contacts_user_id on public.whatsapp_contacts using btree (user_id) tablespace pg_default;

create index if not exists idx_whatsapp_contacts_bridge_room_id on public.whatsapp_contacts using btree (bridge_room_id) tablespace pg_default;

create index if not exists idx_whatsapp_contacts_sync_status on public.whatsapp_contacts using btree (sync_status) tablespace pg_default;

create trigger update_whatsapp_contact_timestamp before
update on whatsapp_contacts for each row
execute function update_whatsapp_contact_timestamp ();

create trigger update_whatsapp_contacts_updated_at before
update on whatsapp_contacts for each row
execute function update_updated_at_column ();