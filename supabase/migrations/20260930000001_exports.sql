-- ============================================================================
-- Exports: CSV downloads + live Google Sheets feeds (=IMPORTDATA).
--
-- Each workspace gets a secret export key. Anyone holding the export URL can
-- read that workspace's reports, so only managers can see or reset the key.
-- The export function is callable without signing in (Google Sheets can't
-- sign in) and checks the key itself.
-- ============================================================================

create table public.export_keys (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  token        text not null unique,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);
alter table public.export_keys enable row level security;
create policy export_keys_select on public.export_keys
  for select to authenticated using (public.is_manager(workspace_id));

-- Returns the workspace's export key, creating it on first use (managers only).
-- p_reset = true replaces it, which breaks every old link and sheet.
create or replace function public.get_export_key(p_workspace uuid, p_reset boolean default false)
returns text
language plpgsql security definer set search_path = public, extensions
as $$
declare
  k text;
begin
  if not public.is_manager(p_workspace) then raise exception 'Not allowed'; end if;
  if not p_reset then
    select token into k from export_keys where workspace_id = p_workspace;
    if k is not null then return k; end if;
  end if;
  k := encode(gen_random_bytes(20), 'hex');
  insert into export_keys (workspace_id, token, created_by)
  values (p_workspace, k, auth.uid())
  on conflict (workspace_id) do update
    set token = excluded.token, created_by = excluded.created_by, created_at = now();
  return k;
end;
$$;
revoke execute on function public.get_export_key(uuid, boolean) from public, anon;
grant  execute on function public.get_export_key(uuid, boolean) to authenticated;

-- Export rows as a JSON array of objects.
--   p_kind: 'daily'   one row per rep per day (EOD sign-offs)
--           'clients' one row per rep per client per day
--           'calls'   one row per answered call
create or replace function public.export_data(p_token text, p_kind text, p_days int default 90, p_tz text default 'America/New_York')
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  ws       uuid;
  since    timestamptz;
  since_d  date;
  t_dials  int;
  t_booked int;
  result   jsonb;
begin
  if p_token is null or length(p_token) < 32 then raise exception 'Invalid export link'; end if;
  select workspace_id into ws from export_keys where token = p_token;
  if ws is null then raise exception 'Invalid export link'; end if;

  p_days  := least(greatest(coalesce(p_days, 90), 1), 366);
  since_d := (now() at time zone p_tz)::date - (p_days - 1);
  since   := (since_d::timestamp at time zone p_tz);
  select min_dials, min_booked into t_dials, t_booked from workspaces where id = ws;

  if p_kind = 'daily' then
    select coalesce(jsonb_agg(r order by r.date desc, r.rep), '[]'::jsonb) into result from (
      select e.day as date,
             coalesce(p.full_name, p.email) as rep,
             p.email,
             coalesce(e.dials, 0) as dials,
             e.conversations,
             e.booked,
             case when e.conversations > 0 then round(100.0 * e.booked / e.conversations) end as book_rate,
             case when t_dials is null and t_booked is null then null
                  when (t_dials is not null and coalesce(e.dials, 0) >= t_dials)
                    or (t_booked is not null and e.booked >= t_booked) then 'Yes' else 'No' end as on_target,
             e.energy,
             e.went_well,
             e.improve,
             e.blockers,
             (select string_agg(coalesce(c.name, 'No client') || ': ' || kv.value, ', ' order by c.name)
                from jsonb_each_text(e.dials_by_client) kv
                left join clients c on c.id::text = kv.key) as dials_by_client,
             e.updated_at as signed_off_at
      from eods e join profiles p on p.id = e.rep_id
      where e.workspace_id = ws and e.day >= since_d
    ) r;

  elsif p_kind = 'clients' then
    with logs as (
      select l.rep_id, l.client_id, (l.created_at at time zone p_tz)::date as day, o.is_success, l.stage_id, l.objection_id
      from call_logs l join options o on o.id = l.outcome_id
      where l.workspace_id = ws and l.created_at >= since
    ),
    dials as (
      select e.rep_id, e.day,
             case when kv.key ~ '^[0-9a-f-]{36}$' then kv.key::uuid end as client_id,
             case when kv.value ~ '^[0-9]+$' then kv.value::int else 0 end as dials
      from eods e, jsonb_each_text(e.dials_by_client) kv
      where e.workspace_id = ws and e.day >= since_d and e.dials_by_client is not null
      union all
      select e.rep_id, e.day, null, coalesce(e.dials, 0)
      from eods e
      where e.workspace_id = ws and e.day >= since_d and (e.dials_by_client is null or e.dials_by_client = '{}'::jsonb)
    ),
    keys as (
      select rep_id, client_id, day from logs
      union
      select rep_id, client_id, day from dials where dials > 0
    )
    select coalesce(jsonb_agg(r order by r.date desc, r.rep, r.client), '[]'::jsonb) into result from (
      select k.day as date,
             coalesce(p.full_name, p.email) as rep,
             coalesce(c.name, 'No client') as client,
             (select coalesce(sum(d.dials), 0) from dials d
               where d.rep_id = k.rep_id and d.day = k.day and d.client_id is not distinct from k.client_id) as dials,
             (select count(*) from logs l
               where l.rep_id = k.rep_id and l.day = k.day and l.client_id is not distinct from k.client_id) as conversations,
             (select count(*) from logs l
               where l.rep_id = k.rep_id and l.day = k.day and l.client_id is not distinct from k.client_id and l.is_success) as booked,
             (select o.label from logs l join options o on o.id = l.stage_id
               where l.rep_id = k.rep_id and l.day = k.day and l.client_id is not distinct from k.client_id
               group by o.label order by count(*) desc, o.label limit 1) as most_died_at,
             (select o.label from logs l join options o on o.id = l.objection_id
               where l.rep_id = k.rep_id and l.day = k.day and l.client_id is not distinct from k.client_id
               group by o.label order by count(*) desc, o.label limit 1) as top_objection
      from keys k
      join profiles p on p.id = k.rep_id
      left join clients c on c.id = k.client_id
    ) r;

  elsif p_kind = 'calls' then
    select coalesce(jsonb_agg(r order by r.logged_at desc), '[]'::jsonb) into result from (
      select to_char(l.created_at at time zone p_tz, 'YYYY-MM-DD') as date,
             to_char(l.created_at at time zone p_tz, 'HH24:MI') as time,
             coalesce(p.full_name, p.email) as rep,
             coalesce(c.name, 'No client') as client,
             oo.label as outcome,
             case when oo.is_success then 'Yes' else 'No' end as booked,
             os.label as died_at,
             ob.label as objection,
             l.note,
             l.created_at as logged_at
      from call_logs l
      join profiles p on p.id = l.rep_id
      join options oo on oo.id = l.outcome_id
      left join options os on os.id = l.stage_id
      left join options ob on ob.id = l.objection_id
      left join clients c on c.id = l.client_id
      where l.workspace_id = ws and l.created_at >= since
      order by l.created_at desc
      limit 50000
    ) r;

  else
    raise exception 'Unknown export';
  end if;

  return result;
end;
$$;
revoke execute on function public.export_data(text, text, int, text) from public;
grant  execute on function public.export_data(text, text, int, text) to anon, authenticated;
