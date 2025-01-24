create table
  public.whatsapp_messages (
    id serial not null,
    user_id uuid not null,
    contact_id integer null,
    message_id text not null,
    content text null,
    sender_id text null,
    sender_name text null,
    message_type text null default 'text'::text,
    metadata jsonb null default '{}'::jsonb,
    timestamp timestamp with time zone not null,
    is_read boolean null default false,
    created_at timestamp with time zone null default now(),
    constraint whatsapp_messages_pkey primary key (id),
    constraint whatsapp_messages_user_id_message_id_key unique (user_id, message_id),
    constraint whatsapp_messages_contact_id_fkey foreign key (contact_id) references whatsapp_contacts (id) on delete cascade,
    constraint whatsapp_messages_user_id_fkey foreign key (user_id) references auth.users (id),
    constraint whatsapp_messages_message_type_check check (
      (
        message_type = any (
          array[
            'text'::text,
            'image'::text,
            'video'::text,
            'audio'::text,
            'document'::text,
            'media'::text
          ]
        )
      )
    )
  ) tablespace pg_default;

create index if not exists idx_whatsapp_messages_user_contact on public.whatsapp_messages using btree (user_id, contact_id) tablespace pg_default;

create index if not exists idx_whatsapp_messages_contact_id on public.whatsapp_messages using btree (contact_id) tablespace pg_default;

create index if not exists idx_whatsapp_messages_user_id on public.whatsapp_messages using btree (user_id) tablespace pg_default;

create index if not exists idx_whatsapp_messages_timestamp on public.whatsapp_messages using btree ("timestamp" desc) tablespace pg_default;