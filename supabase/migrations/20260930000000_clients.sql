-- ============================================================================
-- Clients (sub-accounts) inside a workspace + "either/or" daily target.
--
-- * Reps pick which client they're calling for; every call log is tagged.
-- * EOD dials can be split per client (eods.dials_by_client = {client_id: n},
--   key "none" = calls not tagged to a client).
-- * Daily target is hit when EITHER min dials OR min booked is reached.
-- ============================================================================

create table public.clients (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name         text not null check (length(trim(name)) between 1 and 80),
  sort         int not null default 0,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create index clients_ws_idx on public.clients (workspace_id, sort);

alter table public.clients enable row level security;
create policy clients_select on public.clients
  for select to authenticated using (public.is_member(workspace_id));
create policy clients_insert on public.clients
  for insert to authenticated with check (public.is_manager(workspace_id));
create policy clients_update on public.clients
  for update to authenticated
  using (public.is_manager(workspace_id)) with check (public.is_manager(workspace_id));

alter table public.call_logs add column client_id uuid references public.clients (id);
create index call_logs_client_idx on public.call_logs (workspace_id, client_id, created_at desc);

alter table public.eods add column dials_by_client jsonb;

-- Call logs must reference options AND a client from the same workspace.
create or replace function public.check_call_log_options()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from options o
                 where o.id = new.outcome_id and o.workspace_id = new.workspace_id and o.kind = 'outcome') then
    raise exception 'Invalid outcome for this workspace';
  end if;
  if new.stage_id is not null and not exists (select 1 from options o
                 where o.id = new.stage_id and o.workspace_id = new.workspace_id and o.kind = 'stage') then
    raise exception 'Invalid stage for this workspace';
  end if;
  if new.objection_id is not null and not exists (select 1 from options o
                 where o.id = new.objection_id and o.workspace_id = new.workspace_id and o.kind = 'objection') then
    raise exception 'Invalid objection for this workspace';
  end if;
  if new.client_id is not null and not exists (select 1 from clients c
                 where c.id = new.client_id and c.workspace_id = new.workspace_id) then
    raise exception 'Invalid client for this workspace';
  end if;
  return new;
end;
$$;
revoke execute on function public.check_call_log_options() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Stats: optional client filter + per-client and rep × client breakdowns.
-- ---------------------------------------------------------------------------
drop function if exists public.workspace_stats(uuid, timestamptz, timestamptz, text);

create or replace function public.workspace_stats(
  p_workspace uuid,
  p_from      timestamptz,
  p_to        timestamptz,
  p_tz        text default 'America/New_York',
  p_client    uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  result   jsonb;
  t_dials  int;
  t_booked int;
begin
  if not public.is_manager(p_workspace) then raise exception 'Not allowed'; end if;
  select min_dials, min_booked into t_dials, t_booked from workspaces where id = p_workspace;

  with all_logs as (
    select l.*, o.is_success
    from call_logs l
    join options o on o.id = l.outcome_id
    where l.workspace_id = p_workspace and l.created_at >= p_from and l.created_at < p_to
  ),
  logs as (
    select * from all_logs where p_client is null or client_id = p_client
  ),
  day_eods as (
    select e.* from eods e
    where e.workspace_id = p_workspace
      and e.day >= (p_from at time zone p_tz)::date
      and e.day <  (p_to   at time zone p_tz)::date
  ),
  -- One row per rep / day / client with the dials reported for it.
  eod_dials as (
    select e.rep_id, e.day,
           case when kv.key ~ '^[0-9a-f-]{36}$' then kv.key::uuid end as client_id,
           case when kv.value ~ '^[0-9]+$' then kv.value::int else 0 end as dials
    from day_eods e, jsonb_each_text(e.dials_by_client) kv
    where e.dials_by_client is not null and e.dials_by_client <> '{}'::jsonb
    union all
    select e.rep_id, e.day, null::uuid, coalesce(e.dials, 0)
    from day_eods e
    where e.dials_by_client is null or e.dials_by_client = '{}'::jsonb
  ),
  dials as (
    select * from eod_dials where p_client is null or client_id = p_client
  ),
  team as (
    select m.user_id, m.role, p.full_name, p.email
    from memberships m join profiles p on p.id = m.user_id
    where m.workspace_id = p_workspace and m.active
  ),
  reps as (
    select
      t.user_id, t.full_name, t.email, t.role,
      count(l.id)                                   as conversations,
      count(l.id) filter (where l.is_success)       as booked,
      max(l.created_at)                             as last_log,
      (select count(*) from day_eods e where e.rep_id = t.user_id)                        as eods,
      (select round(avg(e.energy)::numeric, 1) from day_eods e where e.rep_id = t.user_id) as avg_energy,
      (select coalesce(sum(d.dials), 0) from dials d where d.rep_id = t.user_id)          as dials,
      -- Target hit = min dials OR min booked reached (whichever targets are set).
      (select count(*) from day_eods e where e.rep_id = t.user_id and (
          (t_dials is null and t_booked is null)
          or (t_dials  is not null and coalesce(e.dials, 0) >= t_dials)
          or (t_booked is not null and e.booked >= t_booked)))                            as days_hit,
      (select jsonb_object_agg(s.stage_id, s.n) from (
          select l2.stage_id, count(*) n from logs l2
          where l2.rep_id = t.user_id and l2.stage_id is not null
          group by l2.stage_id) s)                  as stages
    from team t
    left join logs l on l.rep_id = t.user_id
    group by t.user_id, t.full_name, t.email, t.role
  ),
  client_keys as (
    select c.id, c.name, c.sort, c.active from clients c where c.workspace_id = p_workspace
    union all
    select null::uuid, 'No client', 1000000, true
  ),
  clients_out as (
    select k.id, k.name, k.sort, k.active,
      (select count(*) from all_logs l where l.client_id is not distinct from k.id)                    as conversations,
      (select count(*) from all_logs l where l.client_id is not distinct from k.id and l.is_success)   as booked,
      (select coalesce(sum(d.dials), 0) from eod_dials d where d.client_id is not distinct from k.id)  as dials,
      (select count(distinct l.rep_id) from all_logs l where l.client_id is not distinct from k.id)    as reps,
      (select o.label from all_logs l join options o on o.id = l.stage_id
        where l.client_id is not distinct from k.id group by o.label order by count(*) desc, o.label limit 1) as top_stage,
      (select o.label from all_logs l join options o on o.id = l.objection_id
        where l.client_id is not distinct from k.id group by o.label order by count(*) desc, o.label limit 1) as top_objection
    from client_keys k
  ),
  pairs as (
    select rep_id, client_id from all_logs
    union
    select rep_id, client_id from eod_dials where dials > 0
  ),
  rep_clients as (
    select pr.rep_id as user_id, coalesce(p.full_name, p.email) as rep_name,
           pr.client_id, coalesce(c.name, 'No client') as client_name,
      (select count(*) from all_logs l where l.rep_id = pr.rep_id and l.client_id is not distinct from pr.client_id)                  as conversations,
      (select count(*) from all_logs l where l.rep_id = pr.rep_id and l.client_id is not distinct from pr.client_id and l.is_success) as booked,
      (select coalesce(sum(d.dials), 0) from eod_dials d where d.rep_id = pr.rep_id and d.client_id is not distinct from pr.client_id) as dials,
      (select o.label from all_logs l join options o on o.id = l.stage_id
        where l.rep_id = pr.rep_id and l.client_id is not distinct from pr.client_id
        group by o.label order by count(*) desc, o.label limit 1) as top_stage,
      (select o.label from all_logs l join options o on o.id = l.objection_id
        where l.rep_id = pr.rep_id and l.client_id is not distinct from pr.client_id
        group by o.label order by count(*) desc, o.label limit 1) as top_objection
    from pairs pr
    join profiles p on p.id = pr.rep_id
    left join clients c on c.id = pr.client_id
  )
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
                 'conversations', count(*),
                 'booked', count(*) filter (where is_success),
                 'active_reps', count(distinct rep_id),
                 'dials', (select coalesce(sum(dials), 0) from dials))
               from logs),
    'targets', jsonb_build_object('min_dials', t_dials, 'min_booked', t_booked),
    'reps', coalesce((select jsonb_agg(to_jsonb(r) order by r.booked desc, r.conversations desc) from reps r), '[]'::jsonb),
    'clients', coalesce((select jsonb_agg(to_jsonb(c) order by c.sort, c.name) from clients_out c
                         where (c.id is not null and c.active) or c.conversations > 0 or c.dials > 0), '[]'::jsonb),
    'rep_clients', coalesce((select jsonb_agg(to_jsonb(rc) order by rc.rep_name, rc.client_name) from rep_clients rc
                             where p_client is null or rc.client_id = p_client), '[]'::jsonb),
    'outcomes', coalesce((select jsonb_agg(x order by x.sort) from (
        select o.id, o.label, o.is_success, o.sort, count(l.id) as n
        from options o left join logs l on l.outcome_id = o.id
        where o.workspace_id = p_workspace and o.kind = 'outcome'
        group by o.id) x), '[]'::jsonb),
    'stages', coalesce((select jsonb_agg(x order by x.sort) from (
        select o.id, o.label, o.sort, count(l.id) as n
        from options o left join logs l on l.stage_id = o.id
        where o.workspace_id = p_workspace and o.kind = 'stage'
        group by o.id) x), '[]'::jsonb),
    'objections', coalesce((select jsonb_agg(x order by x.n desc, x.sort) from (
        select o.id, o.label, o.sort, count(l.id) as n
        from options o left join logs l on l.objection_id = o.id
        where o.workspace_id = p_workspace and o.kind = 'objection'
        group by o.id) x), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(x order by x.day) from (
        select (created_at at time zone p_tz)::date as day,
               count(*) as conversations,
               count(*) filter (where is_success) as booked
        from logs group by 1) x), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;
revoke execute on function public.workspace_stats(uuid, timestamptz, timestamptz, text, uuid) from public, anon;
grant  execute on function public.workspace_stats(uuid, timestamptz, timestamptz, text, uuid) to authenticated;
