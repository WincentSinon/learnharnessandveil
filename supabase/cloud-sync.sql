-- Veil Study cloud sync. Run once in your Supabase project's SQL Editor.
-- Safe to run again. This creates only Veil tables/functions/policies and a private PDF bucket.
-- App settings need the project URL and publishable/anon key, never a service_role key.
begin;

create table if not exists public.veil_sync_records (
  owner_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (length(key) between 1 and 512),
  kind text not null,
  revision bigint not null default 1 check (revision > 0),
  payload jsonb not null default '{}'::jsonb,
  tombstone boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (owner_id, key)
);
alter table public.veil_sync_records enable row level security;
drop policy if exists veil_records_owner_read on public.veil_sync_records;
create policy veil_records_owner_read on public.veil_sync_records
  for select to authenticated using (owner_id = (select auth.uid()));
revoke all on table public.veil_sync_records from anon, authenticated;
grant select on table public.veil_sync_records to authenticated;

-- The expected revision makes updates atomic: a stale client cannot erase another device's work.
-- Only this function can write records. Its owner is the project administrator executing this script.
create or replace function public.veil_sync_put(
  p_key text, p_kind text, p_payload jsonb,
  p_tombstone boolean, p_expected_revision bigint
) returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  v_owner uuid := auth.uid();
  v_row public.veil_sync_records%rowtype;
begin
  if v_owner is null then
    raise exception 'Sign in before syncing' using errcode = '42501';
  end if;
  if p_key is null or p_key !~ '^[A-Za-z0-9_.:/-]{1,512}$'
     or p_kind is null or p_kind !~ '^[a-z][a-z0-9_-]{0,63}$'
     or p_expected_revision is null or p_expected_revision < 0
     or p_tombstone is null
     or octet_length(coalesce(p_payload, 'null'::jsonb)::text) > 16777216 then
    raise exception 'Invalid sync record' using errcode = '22023';
  end if;
  if p_expected_revision = 0 then
    insert into public.veil_sync_records(owner_id, key, kind, revision, payload, tombstone)
      values (v_owner, p_key, p_kind, 1, coalesce(p_payload, 'null'::jsonb), p_tombstone)
      on conflict (owner_id, key) do nothing returning * into v_row;
  else
    update public.veil_sync_records as r
      set kind = p_kind, payload = coalesce(p_payload, 'null'::jsonb), tombstone = p_tombstone,
          revision = r.revision + 1, updated_at = now()
      where r.owner_id = v_owner and r.key = p_key and r.revision = p_expected_revision
      returning r.* into v_row;
  end if;
  if not found then
    raise exception 'sync_revision_conflict' using errcode = '40001';
  end if;
  return to_jsonb(v_row);
end;
$function$;
revoke all on function public.veil_sync_put(text, text, jsonb, boolean, bigint) from public, anon;
grant execute on function public.veil_sync_put(text, text, jsonb, boolean, bigint) to authenticated;

-- PDF names are <signed-in-user-id>/<sha256>.pdf. The bucket must remain private.
insert into storage.buckets(id, name, public)
  values ('veil-pdfs', 'veil-pdfs', false)
  on conflict (id) do update set public = false;
drop policy if exists veil_pdfs_owner_read on storage.objects;
drop policy if exists veil_pdfs_owner_insert on storage.objects;
drop policy if exists veil_pdfs_owner_update on storage.objects;
drop policy if exists veil_pdfs_owner_delete on storage.objects;
create policy veil_pdfs_owner_read on storage.objects for select to authenticated
  using (bucket_id = 'veil-pdfs' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy veil_pdfs_owner_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'veil-pdfs' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy veil_pdfs_owner_update on storage.objects for update to authenticated
  using (bucket_id = 'veil-pdfs' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'veil-pdfs' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy veil_pdfs_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'veil-pdfs' and (storage.foldername(name))[1] = (select auth.uid())::text);
commit;
