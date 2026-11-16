-- Ritmo: private per-account records with optimistic concurrency.
create table public.ritmo_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  record_key text not null check (record_key = 'settings' or record_key ~ '^day:[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  data jsonb,
  deleted boolean not null default false,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, record_key),
  check ((deleted and data is null) or (not deleted and jsonb_typeof(data) = 'object')),
  check (octet_length(data::text) <= 1048576)
);

alter table public.ritmo_records enable row level security;
revoke all on public.ritmo_records from anon, authenticated;
grant select, insert, update on public.ritmo_records to authenticated;

create policy ritmo_select_own on public.ritmo_records for select to authenticated
  using ((select auth.uid()) = user_id);
create policy ritmo_insert_own on public.ritmo_records for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy ritmo_update_own on public.ritmo_records for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create function public.ritmo_save_record(
  p_key text, p_data jsonb, p_expected_revision bigint, p_deleted boolean default false
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  current_record public.ritmo_records%rowtype;
begin
  if owner_id is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Invalid revision' using errcode = '22023';
  end if;
  select * into current_record from public.ritmo_records
    where user_id = owner_id and record_key = p_key for update;

  if not found then
    if p_expected_revision <> 0 then
      return jsonb_build_object('ok', false, 'record', null);
    end if;
    insert into public.ritmo_records(user_id, record_key, data, deleted)
      values(owner_id, p_key, case when p_deleted then null else p_data end, p_deleted)
      on conflict do nothing returning * into current_record;
    if found then return jsonb_build_object('ok', true, 'record', to_jsonb(current_record)); end if;
    select * into current_record from public.ritmo_records
      where user_id = owner_id and record_key = p_key for update;
  end if;

  if current_record.revision <> p_expected_revision then
    return jsonb_build_object('ok', false, 'record', to_jsonb(current_record));
  end if;
  update public.ritmo_records
    set data = case when p_deleted then null else p_data end,
        deleted = p_deleted, revision = revision + 1, updated_at = clock_timestamp()
    where user_id = owner_id and record_key = p_key returning * into current_record;
  return jsonb_build_object('ok', true, 'record', to_jsonb(current_record));
end;
$$;
revoke all on function public.ritmo_save_record(text,jsonb,bigint,boolean) from public, anon;
grant execute on function public.ritmo_save_record(text,jsonb,bigint,boolean) to authenticated;
