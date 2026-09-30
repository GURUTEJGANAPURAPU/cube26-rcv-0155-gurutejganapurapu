-- ---------------------------------------------------------------------------
-- Receiving Manager — initial schema
--
-- Tenancy model
--   Every tenant-owned table carries organization_id and has RLS ENABLED and
--   FORCED. Access is granted only when the row's organization_id equals the
--   caller's organisation, resolved from public.profiles by auth.uid().
--   Storage objects live under <org_slug>/receiving/<record_id>/<image_id>.ext
--   and are protected by the same rule, so knowing an object key is not
--   sufficient to read another organisation's image.
-- ---------------------------------------------------------------------------

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.app_role as enum ('operator', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.receiving_status as enum ('draft', 'processing', 'pending', 'complete');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.receiving_decision as enum ('PASS', 'EXCEPTION', 'UNCERTAIN', 'PENDING');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.check_verdict as enum ('PASS', 'FAIL', 'UNCERTAIN');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.capture_type as enum ('overview', 'carton_label', 'quantity', 'product', 'damage', 'other');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Organisations and profiles
-- ---------------------------------------------------------------------------
create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  is_demo     boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  display_name    text,
  operator_label  text,
  created_at      timestamptz not null default now()
);

-- Roles live in their own table. Never on profiles.
create table if not exists public.user_roles (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role    public.app_role not null,
  unique (user_id, role)
);

-- ---------------------------------------------------------------------------
-- Security-definer helpers (avoid recursive RLS)
-- ---------------------------------------------------------------------------
create or replace function public.app_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id from public.profiles where id = auth.uid()
$$;

create or replace function public.app_org_slug()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select o.slug
  from public.profiles p
  join public.organizations o on o.id = p.organization_id
  where p.id = auth.uid()
$$;

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles where user_id = _user_id and role = _role
  )
$$;

-- ---------------------------------------------------------------------------
-- Purchase orders
-- ---------------------------------------------------------------------------
create table if not exists public.purchase_orders (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  po_number       text not null,
  supplier        text not null,
  ordered_at      timestamptz,
  is_demo         boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (organization_id, po_number, supplier)
);

create table if not exists public.purchase_order_lines (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  purchase_order_id        uuid not null references public.purchase_orders(id) on delete cascade,
  po_line                  integer not null,
  unit_id                  text,
  source_record_id         text,
  sku                      text not null,
  asin                     text,
  product_title            text not null,
  spec_colour              text,
  spec_variant             text,
  spec_components          text[] not null default '{}',
  cartons_ordered          integer not null default 1,
  units_per_carton_ordered integer not null default 1,
  qty_ordered              integer not null default 1,
  is_demo                  boolean not null default false,
  created_at               timestamptz not null default now(),
  unique (organization_id, purchase_order_id, po_line)
);

-- ---------------------------------------------------------------------------
-- Receiving
-- ---------------------------------------------------------------------------
create table if not exists public.receiving_records (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  po_line_id             uuid references public.purchase_order_lines(id) on delete set null,
  unit_id                text,
  po_number              text not null,
  po_line                integer,
  supplier               text,
  sku                    text,
  status                 public.receiving_status not null default 'draft',
  decision               public.receiving_decision,
  captured_at            timestamptz not null default now(),
  operator_id            uuid references auth.users(id) on delete set null,
  operator_label         text,
  model_version          text,
  prompt_version         text,
  latency_ms             integer,
  inspection_started_at  timestamptz,
  inspection_completed_at timestamptz,
  attempt_count          integer not null default 0,
  failure_reason         text,
  recommended_action     text,
  observations           jsonb,
  coverage               jsonb,
  content_hash           text,
  capture_hash           text,
  is_demo                boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- Idempotency: the same evidence set for the same PO line does not silently
-- create a second record. An explicit re-inspection is a new attempt instead.
create unique index if not exists receiving_records_capture_hash_idx
  on public.receiving_records (organization_id, capture_hash)
  where capture_hash is not null;

create index if not exists receiving_records_org_idx        on public.receiving_records (organization_id);
create index if not exists receiving_records_po_idx         on public.receiving_records (organization_id, po_number);
create index if not exists receiving_records_unit_idx       on public.receiving_records (organization_id, unit_id);
create index if not exists receiving_records_created_idx    on public.receiving_records (organization_id, created_at desc);
create index if not exists receiving_records_decision_idx   on public.receiving_records (organization_id, decision);
create index if not exists receiving_records_status_idx     on public.receiving_records (organization_id, status);

create table if not exists public.receiving_images (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  receiving_record_id uuid not null references public.receiving_records(id) on delete cascade,
  storage_path        text not null,
  original_filename   text,
  mime_type           text not null,
  size_bytes          integer not null,
  sha256              text,
  capture_type        public.capture_type not null default 'other',
  width               integer,
  height              integer,
  quality_score       numeric,
  quality_flags       text[] not null default '{}',
  ocr_text            text,
  barcode_value       text,
  uploaded_at         timestamptz not null default now()
);

create index if not exists receiving_images_record_idx on public.receiving_images (receiving_record_id);
create index if not exists receiving_images_org_idx    on public.receiving_images (organization_id);

create table if not exists public.inspection_checks (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  receiving_record_id uuid not null references public.receiving_records(id) on delete cascade,
  check_key           text not null,
  verdict             public.check_verdict not null,
  confidence          numeric,
  expected_value      text,
  observed_value      text,
  detail              text,
  evidence_image_ids  uuid[] not null default '{}',
  evidence_sufficiency text not null default 'sufficient',
  recommended_action  text,
  model_version       text,
  prompt_version      text,
  latency_ms          integer,
  created_at          timestamptz not null default now(),
  unique (receiving_record_id, check_key)
);

create index if not exists inspection_checks_record_idx on public.inspection_checks (receiving_record_id);
create index if not exists inspection_checks_org_idx    on public.inspection_checks (organization_id);

-- Overrides are append-only data. The agent verdict is never overwritten.
create table if not exists public.overrides (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  receiving_record_id uuid not null references public.receiving_records(id) on delete cascade,
  check_key           text,
  original_verdict    text not null,
  new_verdict         text not null,
  reason              text not null,
  operator_id         uuid references auth.users(id) on delete set null,
  operator_label      text,
  created_at          timestamptz not null default now()
);

create index if not exists overrides_record_idx on public.overrides (receiving_record_id);
create index if not exists overrides_org_idx    on public.overrides (organization_id);

create table if not exists public.inspection_attempts (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  receiving_record_id uuid not null references public.receiving_records(id) on delete cascade,
  attempt_no          integer not null,
  outcome             text not null,            -- success | model_error | timeout | rate_limited | invalid_response
  error_message       text,
  model_version       text,
  prompt_version      text,
  latency_ms          integer,
  created_at          timestamptz not null default now()
);

create index if not exists inspection_attempts_record_idx  on public.inspection_attempts (receiving_record_id);
create index if not exists inspection_attempts_created_idx on public.inspection_attempts (organization_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists receiving_records_touch on public.receiving_records;
create trigger receiving_records_touch
  before update on public.receiving_records
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Grants (PostgREST does not grant public-schema privileges by default)
-- ---------------------------------------------------------------------------
grant select on public.organizations to authenticated;
grant all    on public.organizations to service_role;

grant select on public.profiles to authenticated;
grant all    on public.profiles to service_role;

grant select on public.user_roles to authenticated;
grant all    on public.user_roles to service_role;

grant select, insert, update, delete on public.purchase_orders      to authenticated;
grant all                            on public.purchase_orders      to service_role;
grant select, insert, update, delete on public.purchase_order_lines to authenticated;
grant all                            on public.purchase_order_lines to service_role;
grant select, insert, update, delete on public.receiving_records    to authenticated;
grant all                            on public.receiving_records    to service_role;
grant select, insert, update, delete on public.receiving_images     to authenticated;
grant all                            on public.receiving_images     to service_role;
grant select, insert, update, delete on public.inspection_checks    to authenticated;
grant all                            on public.inspection_checks    to service_role;
grant select, insert                 on public.overrides            to authenticated;
grant all                            on public.overrides            to service_role;
grant select, insert                 on public.inspection_attempts  to authenticated;
grant all                            on public.inspection_attempts  to service_role;

-- No grants to anon. Nothing in this application is public.

-- ---------------------------------------------------------------------------
-- Row Level Security — enabled AND forced on every tenant-owned table
-- ---------------------------------------------------------------------------
alter table public.organizations        enable row level security;
alter table public.organizations        force  row level security;
alter table public.profiles             enable row level security;
alter table public.profiles             force  row level security;
alter table public.user_roles           enable row level security;
alter table public.user_roles           force  row level security;
alter table public.purchase_orders      enable row level security;
alter table public.purchase_orders      force  row level security;
alter table public.purchase_order_lines enable row level security;
alter table public.purchase_order_lines force  row level security;
alter table public.receiving_records    enable row level security;
alter table public.receiving_records    force  row level security;
alter table public.receiving_images     enable row level security;
alter table public.receiving_images     force  row level security;
alter table public.inspection_checks    enable row level security;
alter table public.inspection_checks    force  row level security;
alter table public.overrides            enable row level security;
alter table public.overrides            force  row level security;
alter table public.inspection_attempts  enable row level security;
alter table public.inspection_attempts  force  row level security;

drop policy if exists "own organisation readable" on public.organizations;
create policy "own organisation readable" on public.organizations
  for select to authenticated using (id = public.app_org_id());

drop policy if exists "own profile readable" on public.profiles;
create policy "own profile readable" on public.profiles
  for select to authenticated using (id = auth.uid() or organization_id = public.app_org_id());

drop policy if exists "own roles readable" on public.user_roles;
create policy "own roles readable" on public.user_roles
  for select to authenticated using (user_id = auth.uid());

-- Tenant tables: one policy per command, all keyed on organization_id.
do $$
declare t text;
begin
  foreach t in array array[
    'purchase_orders','purchase_order_lines','receiving_records',
    'receiving_images','inspection_checks'
  ] loop
    execute format('drop policy if exists "org select" on public.%I', t);
    execute format('create policy "org select" on public.%I for select to authenticated using (organization_id = public.app_org_id())', t);
    execute format('drop policy if exists "org insert" on public.%I', t);
    execute format('create policy "org insert" on public.%I for insert to authenticated with check (organization_id = public.app_org_id())', t);
    execute format('drop policy if exists "org update" on public.%I', t);
    execute format('create policy "org update" on public.%I for update to authenticated using (organization_id = public.app_org_id()) with check (organization_id = public.app_org_id())', t);
    execute format('drop policy if exists "org delete" on public.%I', t);
    execute format('create policy "org delete" on public.%I for delete to authenticated using (organization_id = public.app_org_id())', t);
  end loop;

  -- Append-only tables: select + insert only, no update/delete policy at all.
  foreach t in array array['overrides','inspection_attempts'] loop
    execute format('drop policy if exists "org select" on public.%I', t);
    execute format('create policy "org select" on public.%I for select to authenticated using (organization_id = public.app_org_id())', t);
    execute format('drop policy if exists "org insert" on public.%I', t);
    execute format('create policy "org insert" on public.%I for insert to authenticated with check (organization_id = public.app_org_id())', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Private storage bucket + organisation-scoped object policies
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receiving-evidence',
  'receiving-evidence',
  false,
  8388608,
  array['image/jpeg','image/png','image/webp']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "evidence read own org"   on storage.objects;
drop policy if exists "evidence write own org"  on storage.objects;
drop policy if exists "evidence update own org" on storage.objects;
drop policy if exists "evidence delete own org" on storage.objects;

create policy "evidence read own org" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'receiving-evidence'
    and (storage.foldername(name))[1] = public.app_org_slug()
  );

create policy "evidence write own org" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'receiving-evidence'
    and (storage.foldername(name))[1] = public.app_org_slug()
  );

create policy "evidence update own org" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'receiving-evidence'
    and (storage.foldername(name))[1] = public.app_org_slug()
  );

create policy "evidence delete own org" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'receiving-evidence'
    and (storage.foldername(name))[1] = public.app_org_slug()
  );
