create table
  public.whatsapp_sync_requests (
    id serial not null,
    user_id uuid not null,
    contact_id integer null,
    status text null default 'pending'::text,
    requested_at timestamp with time zone null default now(),
    approved_at timestamp with time zone null,
    metadata jsonb null default '{}'::jsonb,
    constraint whatsapp_sync_requests_pkey primary key (id),
    constraint whatsapp_sync_requests_user_id_contact_id_key unique (user_id, contact_id),
    constraint whatsapp_sync_requests_contact_id_fkey foreign key (contact_id) references whatsapp_contacts (id) on delete cascade,
    constraint whatsapp_sync_requests_user_id_fkey foreign key (user_id) references auth.users (id),
    constraint whatsapp_sync_requests_status_check check (
      (
        status = any (
          array[
            'pending'::text,
            'approved'::text,
            'rejected'::text
          ]
        )
      )
    )
  ) tablespace pg_default;

create index if not exists idx_whatsapp_sync_requests_user_id on public.whatsapp_sync_requests using btree (user_id) tablespace pg_default;

create index if not exists idx_whatsapp_sync_requests_contact_id on public.whatsapp_sync_requests using btree (contact_id) tablespace pg_default;

create index if not exists idx_whatsapp_sync_requests_user_status on public.whatsapp_sync_requests using btree (user_id, status) tablespace pg_default;