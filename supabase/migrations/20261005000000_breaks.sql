-- ============================================================================
-- Breaks: reps press Pause in the extension / web logger when they step away.
-- Break time is taken out of "time between pick-ups" and pick-ups per hour,
-- and the dashboard shows who is on break.
-- ============================================================================

create table public.breaks (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  rep_id       uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  check (ended_at is null or ended_at >= started_at)
);
create index breaks_ws_time_idx on public.breaks (workspace_id, started_at desc);
create index breaks_rep_time_idx on public.breaks (rep_id, started_at desc);
-- One open break per rep per workspace.
create unique index breaks_one_open on public.breaks (workspace_id, rep_id) where ended_at is null;

alter table public.breaks enable row level security;
create policy breaks_select on public.breaks
  for select to authenticated
  using (rep_id = auth.uid() or public.is_manager(workspace_id));
create policy breaks_insert on public.breaks
  for insert to authenticated
  with check (rep_id = auth.uid() and public.is_member(workspace_id));
create policy breaks_update_own on public.breaks
  for update to authenticated
  using (rep_id = auth.uid())
  with check (rep_id = auth.uid());
create policy breaks_delete_own on public.breaks
  for delete to authenticated
  using (rep_id = auth.uid() and started_at > now() - interval '15 minutes');

-- Effective end of a break: still running = now; forgotten breaks count for at most 2 hours.
create or replace function public.break_end(p_start timestamptz, p_end timestamptz)
returns timestamptz
language sql stable set search_path = public
as $$ select coalesce(p_end, least(now(), p_start + interval '2 hours')) $$;

create or replace function public.workspace_report(
  p_workspace uuid,
  p_from      timestamptz,
  p_to        timestamptz,
  p_tz        text default 'America/New_York',
  p_client    uuid default null,
  p_rep       uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  result   jsonb;
  span     interval := p_to - p_from;
  t_dials  int;
  t_booked int;
begin
  if not public.is_manager(p_workspace) then raise exception 'Not allowed'; end if;
  select min_dials, min_booked into t_dials, t_booked from workspaces where id = p_workspace;

  with base as (
    select l.id, l.rep_id, l.client_id, l.stage_id, l.objection_id, l.created_at,
           o.is_success, (l.created_at at time zone p_tz) as lt
    from call_logs l
    join options o on o.id = l.outcome_id
    where l.workspace_id = p_workspace
      and (p_client is null or l.client_id = p_client)
      and (p_rep is null or l.rep_id = p_rep)
      and l.created_at >= p_from - span and l.created_at < p_to
  ),
  cur  as (select * from base where created_at >= p_from),
  prev as (select * from base where created_at <  p_from),
  eod as (
    select e.* from eods e
    where e.workspace_id = p_workspace
      and (p_rep is null or e.rep_id = p_rep)
      and e.day >= (p_from at time zone p_tz)::date
      and e.day <  (p_to   at time zone p_tz)::date
  ),
  -- Minutes between a rep's consecutive pick-ups on the same day (all clients),
  -- minus any time the rep was on a logged break in between.
  gap_src as (
    select l.rep_id, l.created_at, (l.created_at at time zone p_tz) as lt
    from call_logs l
    where l.workspace_id = p_workspace
      and (p_rep is null or l.rep_id = p_rep)
      and l.created_at >= p_from and l.created_at < p_to
  ),
  brk as (
    select b.rep_id, b.started_at as s, public.break_end(b.started_at, b.ended_at) as e
    from breaks b
    where b.workspace_id = p_workspace
      and (p_rep is null or b.rep_id = p_rep)
      and b.started_at < p_to
      and public.break_end(b.started_at, b.ended_at) > p_from
  ),
  gaps0 as (
    select rep_id, created_at, lt, lt::date as d,
           lag(created_at) over (partition by rep_id, lt::date order by created_at) as prev_at
    from gap_src
  ),
  gaps as (
    select g.rep_id, g.d, g.lt, g.created_at,
      case when g.prev_at is null then null else
        greatest(0, extract(epoch from g.created_at - g.prev_at)
          - coalesce((select sum(extract(epoch from least(b.e, g.created_at) - greatest(b.s, g.prev_at)))
                      from brk b
                      where b.rep_id = g.rep_id and b.s < g.created_at and b.e > g.prev_at), 0)) / 60.0
      end as gap
    from gaps0 g
  ),
  rep_days as (
    select rep_id, d, count(*) as n, min(lt) as first_at, max(lt) as last_at, max(gap) as longest,
           count(*) filter (where gap >= 30) as long_gaps,
           min(created_at) as first_utc, max(created_at) as last_utc
    from gaps group by rep_id, d
  ),
  -- Break minutes inside each rep-day's first→last pick-up span.
  rep_days_b as (
    select rd.*,
      coalesce((select sum(extract(epoch from least(b.e, rd.last_utc) - greatest(b.s, rd.first_utc))) / 60.0
                from brk b where b.rep_id = rd.rep_id and b.s < rd.last_utc and b.e > rd.first_utc), 0) as break_min
    from rep_days rd
  ),
  stage_opts as (
    select o.id, o.label, o.sort from options o
    where o.workspace_id = p_workspace and o.kind = 'stage'
      and (o.active or exists (select 1 from cur c where c.stage_id = o.id))
  ),
  rep_ids as (
    select rep_id from cur union select rep_id from eod
  ),
  reps as (
    select r.rep_id as id, coalesce(p.full_name, p.email) as name,
      (select count(*) from cur c  where c.rep_id = r.rep_id)                    as pickups,
      (select count(*) from cur c  where c.rep_id = r.rep_id and c.is_success)   as booked,
      (select count(*) from prev c where c.rep_id = r.rep_id)                    as prev_pickups,
      (select count(*) from prev c where c.rep_id = r.rep_id and c.is_success)   as prev_booked,
      (select count(distinct c.lt::date) from cur c where c.rep_id = r.rep_id)  as days_active,
      (select count(*) from eod e where e.rep_id = r.rep_id)                    as eods,
      (select round(avg(e.dials)) from eod e where e.rep_id = r.rep_id and e.dials is not null) as avg_dials,
      (select count(*) from eod e where e.rep_id = r.rep_id and (
          (t_dials is null and t_booked is null)
          or (t_dials  is not null and coalesce(e.dials, 0) >= t_dials)
          or (t_booked is not null and e.booked >= t_booked)))                   as days_hit,
      (select round(avg(e.energy)::numeric, 1) from eod e where e.rep_id = r.rep_id) as avg_energy,
      (select count(*) from cur c where c.rep_id = r.rep_id and not c.is_success and c.stage_id is not null) as lost_staged,
      (select coalesce(jsonb_object_agg(s.stage_id, s.n), '{}'::jsonb) from (
          select c.stage_id, count(*) n from cur c
          where c.rep_id = r.rep_id and not c.is_success and c.stage_id is not null
          group by c.stage_id) s)                                                as stages,
      (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
          select o.label, count(*) n from cur c join options o on o.id = c.objection_id
          where c.rep_id = r.rep_id group by o.label order by count(*) desc, o.label limit 3) x) as objections
    from rep_ids r
    join profiles p on p.id = r.rep_id
  ),
  client_keys as (
    select c.id, c.name, c.sort from clients c
    where c.workspace_id = p_workspace and (p_client is null or c.id = p_client)
    union all
    select null::uuid, 'No client', 1000000 where p_client is null
  ),
  clients_out as (
    select k.id, k.name, k.sort,
      (select count(*) from cur c  where c.client_id is not distinct from k.id)                  as pickups,
      (select count(*) from cur c  where c.client_id is not distinct from k.id and c.is_success) as booked,
      (select count(*) from prev c where c.client_id is not distinct from k.id)                  as prev_pickups,
      (select count(*) from prev c where c.client_id is not distinct from k.id and c.is_success) as prev_booked,
      (select coalesce(jsonb_object_agg(s.stage_id, s.n), '{}'::jsonb) from (
          select c.stage_id, count(*) n from cur c
          where c.client_id is not distinct from k.id and not c.is_success and c.stage_id is not null
          group by c.stage_id) s)                                                                as stages,
      (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
          select o.label, count(*) n from cur c join options o on o.id = c.objection_id
          where c.client_id is not distinct from k.id
          group by o.label order by count(*) desc, o.label limit 3) x)                           as objections,
      (select jsonb_build_object('name', coalesce(p.full_name, p.email), 'pickups', count(*),
                                 'booked', count(*) filter (where c.is_success))
         from cur c join profiles p on p.id = c.rep_id
         where c.client_id is not distinct from k.id
         group by p.id, p.full_name, p.email
         having count(*) >= 5
         order by (count(*) filter (where c.is_success))::numeric / count(*) desc, count(*) desc
         limit 1)                                                                               as best_rep,
      (select jsonb_build_object('hour', h.hr, 'pickups', h.n, 'booked', h.b) from (
          select extract(hour from c.lt)::int hr, count(*) n, count(*) filter (where c.is_success) b
          from cur c where c.client_id is not distinct from k.id
          group by 1 having count(*) >= 3
          order by (count(*) filter (where c.is_success))::numeric / count(*) desc, count(*) desc
          limit 1) h)                                                                           as best_hour
    from client_keys k
  )
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'pickups',      (select count(*) from cur),
      'booked',       (select count(*) from cur where is_success),
      'prev_pickups', (select count(*) from prev),
      'prev_booked',  (select count(*) from prev where is_success),
      'reps',         (select count(distinct rep_id) from cur),
      'rep_days',     (select count(*) from (select distinct rep_id, lt::date from cur) d),
      'eods',         (select count(*) from eod),
      'eods_hit',     (select count(*) from eod e where
                          (t_dials is null and t_booked is null)
                          or (t_dials  is not null and coalesce(e.dials, 0) >= t_dials)
                          or (t_booked is not null and e.booked >= t_booked)),
      'lost_staged',  (select count(*) from cur where not is_success and stage_id is not null)
    ),
    'targets', jsonb_build_object('min_dials', t_dials, 'min_booked', t_booked),
    'stages',  coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'label', s.label,
                  'n', (select count(*) from cur c where c.stage_id = s.id and not c.is_success))
                  order by s.sort) from stage_opts s), '[]'::jsonb),
    'heatmap', coalesce((select jsonb_agg(x) from (
                  select extract(isodow from lt)::int as dow, extract(hour from lt)::int as hour,
                         count(*) as pickups, count(*) filter (where is_success) as booked
                  from cur group by 1, 2) x), '[]'::jsonb),
    'objections', coalesce((select jsonb_agg(x) from (
                  select o.label, count(*) n from cur c join options o on o.id = c.objection_id
                  group by o.label order by count(*) desc, o.label limit 8) x), '[]'::jsonb),
    'gaps', jsonb_build_object(
      'break_minutes', (select round(sum(extract(epoch from e - s)) / 60.0) from brk),
      'median',   (select round(percentile_cont(0.5) within group (order by gap)::numeric, 1) from gaps where gap is not null),
      'buckets',  coalesce((select jsonb_agg(jsonb_build_object('b', b, 'n', n) order by b) from (
                     select case when gap < 5 then 0 when gap < 10 then 1 when gap < 20 then 2
                                 when gap < 30 then 3 when gap < 60 then 4 else 5 end as b, count(*) n
                     from gaps where gap is not null group by 1) x), '[]'::jsonb),
      'by_hour',  coalesce((select jsonb_agg(jsonb_build_object('hour', h, 'median', m, 'n', n) order by h) from (
                     select extract(hour from lt)::int h,
                            round(percentile_cont(0.5) within group (order by gap)::numeric, 1) m, count(*) n
                     from gaps where gap is not null group by 1) x), '[]'::jsonb),
      'reps',     coalesce((select jsonb_agg(x order by x.median nulls last) from (
                     select g.rep_id as id, coalesce(p.full_name, p.email) as name,
                       round(percentile_cont(0.5) within group (order by g.gap)::numeric, 1)  as median,
                       round(percentile_cont(0.9) within group (order by g.gap)::numeric, 1)  as p90,
                       count(g.gap)                                                          as n_gaps,
                       (select count(*) from rep_days rd where rd.rep_id = g.rep_id)          as days,
                       (select sum(long_gaps) from rep_days rd where rd.rep_id = g.rep_id)   as long_gaps,
                       (select round(avg(longest)::numeric) from rep_days rd where rd.rep_id = g.rep_id and longest is not null) as avg_longest,
                       (select to_char(avg(first_at::time), 'HH24:MI') from rep_days rd where rd.rep_id = g.rep_id) as avg_first,
                       (select to_char(avg(last_at::time),  'HH24:MI') from rep_days rd where rd.rep_id = g.rep_id) as avg_last,
                       (select round(sum(n)::numeric / nullif(sum(greatest(0, extract(epoch from last_at - first_at) / 3600.0 - break_min / 60.0)), 0), 1)
                          from rep_days_b rd where rd.rep_id = g.rep_id and n > 1)          as per_hour,
                       (select round(sum(break_min) / nullif(count(*), 0))
                          from rep_days_b rd where rd.rep_id = g.rep_id)                    as break_per_day,
                       (select count(*) from brk b where b.rep_id = g.rep_id)              as breaks
                     from gaps g join profiles p on p.id = g.rep_id
                     where g.gap is not null
                     group by g.rep_id, p.full_name, p.email) x), '[]'::jsonb)
    ),
    'daily',   coalesce((select jsonb_agg(x order by x.day) from (
                  select lt::date as day, count(*) as pickups, count(*) filter (where is_success) as booked
                  from cur group by 1) x), '[]'::jsonb),
    'reps',    coalesce((select jsonb_agg(to_jsonb(r) order by r.booked desc, r.pickups desc) from reps r), '[]'::jsonb),
    'clients', coalesce((select jsonb_agg(to_jsonb(c) order by c.sort, c.name) from clients_out c
                         where c.id is not null or c.pickups > 0), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;
revoke execute on function public.workspace_report(uuid, timestamptz, timestamptz, text, uuid, uuid) from public, anon;
grant  execute on function public.workspace_report(uuid, timestamptz, timestamptz, text, uuid, uuid) to authenticated;
