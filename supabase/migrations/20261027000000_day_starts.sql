-- ============================================================================
-- "Start my day": reps mark when they start dialing, so the time from the start
-- to the first pick-up is measured too (time between pick-ups, the long-gap
-- question, quiet alerts, unexplained time). One start per rep per day.
-- Additive only (no drops).
-- ============================================================================

create table if not exists public.day_starts (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  rep_id       uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  day          date not null,
  started_at   timestamptz not null default now(),
  source       text not null default 'button' check (source in ('button', 'asked', 'auto')),
  created_at   timestamptz not null default now()
);
create unique index if not exists day_starts_one_per_day on public.day_starts (workspace_id, rep_id, day);
create index if not exists day_starts_ws_time_idx on public.day_starts (workspace_id, started_at desc);
alter table public.day_starts enable row level security;
create policy day_starts_select on public.day_starts
  for select to authenticated using (rep_id = auth.uid() or public.is_manager(workspace_id));
-- A start can be back-dated up to 12h (the "when did you start?" answer), never in the future.
create policy day_starts_insert on public.day_starts
  for insert to authenticated
  with check (rep_id = auth.uid() and public.is_member(workspace_id)
              and started_at <= now() + interval '1 minute' and started_at > now() - interval '12 hours');
create policy day_starts_update_own on public.day_starts
  for update to authenticated
  using (rep_id = auth.uid() and created_at > now() - interval '12 hours')
  with check (rep_id = auth.uid() and started_at <= now() + interval '1 minute' and started_at > now() - interval '12 hours');

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
  -- Pick-ups plus each rep's "Start my day" (only when it came before their first pick-up of that day).
  gap_src as (
    select l.rep_id, l.created_at, l.gap_confirmed, (l.created_at at time zone p_tz) as lt, false as is_start
    from call_logs l
    where l.workspace_id = p_workspace
      and (p_rep is null or l.rep_id = p_rep)
      and l.created_at >= p_from and l.created_at < p_to
    union all
    select s.rep_id, s.started_at, null, (s.started_at at time zone p_tz), true
    from day_starts s
    where s.workspace_id = p_workspace
      and (p_rep is null or s.rep_id = p_rep)
      and s.started_at >= p_from and s.started_at < p_to
      and not exists (select 1 from call_logs l
                      where l.workspace_id = s.workspace_id and l.rep_id = s.rep_id
                        and l.created_at < s.started_at
                        and (l.created_at at time zone p_tz)::date = (s.started_at at time zone p_tz)::date)
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
    select rep_id, created_at, gap_confirmed, lt, lt::date as d, is_start,
           lag(created_at) over (partition by rep_id, lt::date order by created_at, is_start desc) as prev_at,
           coalesce(lag(is_start) over (partition by rep_id, lt::date order by created_at, is_start desc), false) as prev_is_start
    from gap_src
  ),
  gaps as (
    select g.rep_id, g.d, g.lt, g.created_at, coalesce(g.gap_confirmed, false) as confirmed, g.prev_is_start,
      case when g.prev_at is null then null else
        greatest(0, extract(epoch from g.created_at - g.prev_at)
          - coalesce((select sum(extract(epoch from least(b.e, g.created_at) - greatest(b.s, g.prev_at)))
                      from brk b
                      where b.rep_id = g.rep_id and b.s < g.created_at and b.e > g.prev_at), 0)) / 60.0
      end as gap
    from gaps0 g
    where not g.is_start
  ),
  starts as (select rep_id, d, min(created_at) as started_utc, min(lt) as started_lt from gaps0 where is_start group by rep_id, d),
  rep_days as (
    select rep_id, d, count(*) as n, min(lt) as first_at, max(lt) as last_at, max(gap) as longest,
           count(*) filter (where gap >= 30) as long_gaps,
           -- 45+ min with no break logged and the rep didn't confirm they were dialing
           coalesce(sum(gap) filter (where gap >= 45 and not confirmed), 0) as unexplained_min,
           count(*) filter (where gap >= 45 and not confirmed) as unexplained_n,
           min(created_at) as first_utc, max(created_at) as last_utc,
           max(gap) filter (where prev_is_start) as ramp
    from gaps group by rep_id, d
  ),
  -- Break minutes inside each rep-day's first→last pick-up span.
  rep_days_b as (
    select rd.*, st.started_lt,
      coalesce((select sum(extract(epoch from least(b.e, rd.last_utc) - greatest(b.s, rd.first_utc))) / 60.0
                from brk b where b.rep_id = rd.rep_id and b.s < rd.last_utc and b.e > rd.first_utc), 0) as break_min
    from rep_days rd
    left join starts st on st.rep_id = rd.rep_id and st.d = rd.d
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
      'unexplained_minutes', (select round(sum(unexplained_min)) from rep_days),
      'rep_days', (select count(*) from rep_days),
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
                       (select count(*) from brk b where b.rep_id = g.rep_id)              as breaks,
                       (select round(sum(unexplained_min) / nullif(count(*), 0))
                          from rep_days rd where rd.rep_id = g.rep_id)                      as unexplained_per_day,
                       (select sum(unexplained_n) from rep_days rd where rd.rep_id = g.rep_id) as unexplained_n,
                       (select to_char(avg(started_lt::time), 'HH24:MI') from rep_days_b rd where rd.rep_id = g.rep_id and started_lt is not null) as avg_start,
                       (select round(avg(ramp)) from rep_days rd where rd.rep_id = g.rep_id and ramp is not null) as avg_ramp,
                       (select count(*) from rep_days rd where rd.rep_id = g.rep_id and ramp is not null) as ramp_days
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

create or replace function public.rep_report(
  p_workspace uuid,
  p_from      timestamptz,
  p_to        timestamptz,
  p_tz        text default 'America/New_York'
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  me       uuid := auth.uid();
  result   jsonb;
  span     interval := p_to - p_from;
  t_dials  int;
  t_booked int;
  today    date := (now() at time zone p_tz)::date;
begin
  if me is null or not public.is_member(p_workspace) then raise exception 'Not allowed'; end if;
  select min_dials, min_booked into t_dials, t_booked from workspaces where id = p_workspace;

  with base as (
    select l.rep_id, l.stage_id, l.objection_id, l.created_at, o.is_success,
           (l.created_at at time zone p_tz) as lt
    from call_logs l join options o on o.id = l.outcome_id
    where l.workspace_id = p_workspace
      and l.created_at >= p_from - span and l.created_at < p_to
  ),
  cur  as (select * from base where created_at >= p_from),
  prev as (select * from base where created_at <  p_from),
  mine as (select * from cur where rep_id = me),
  eod_all as (
    select e.* from eods e
    where e.workspace_id = p_workspace
      and e.day >= (p_from at time zone p_tz)::date and e.day < (p_to at time zone p_tz)::date
  ),
  hit as (
    select e.rep_id, e.day,
      ((t_dials is null and t_booked is null)
        or (t_dials  is not null and coalesce(e.dials, 0) >= t_dials)
        or (t_booked is not null and e.booked >= t_booked)) as ok
    from eod_all e
  ),
  rep_days as (select distinct rep_id, lt::date as d from cur),
  -- Time between pick-ups, minus logged breaks (same rules as the manager report).
  brk as (
    select b.rep_id, b.started_at as s, public.break_end(b.started_at, b.ended_at) as e
    from breaks b
    where b.workspace_id = p_workspace and b.started_at < p_to
      and public.break_end(b.started_at, b.ended_at) > p_from
  ),
  ev as (
    select rep_id, created_at, lt, false as is_start from cur
    union all
    select s.rep_id, s.started_at, (s.started_at at time zone p_tz), true
    from day_starts s
    where s.workspace_id = p_workspace and s.started_at >= p_from and s.started_at < p_to
      and not exists (select 1 from call_logs l
                      where l.workspace_id = s.workspace_id and l.rep_id = s.rep_id
                        and l.created_at < s.started_at
                        and (l.created_at at time zone p_tz)::date = (s.started_at at time zone p_tz)::date)
  ),
  gaps0 as (
    select rep_id, created_at, lt, is_start,
           lag(created_at) over (partition by rep_id, lt::date order by created_at, is_start desc) as prev_at
    from ev
  ),
  gaps as (
    select g.rep_id,
      greatest(0, extract(epoch from g.created_at - g.prev_at)
        - coalesce((select sum(extract(epoch from least(b.e, g.created_at) - greatest(b.s, g.prev_at)))
                    from brk b where b.rep_id = g.rep_id and b.s < g.created_at and b.e > g.prev_at), 0)) / 60.0 as gap
    from gaps0 g where g.prev_at is not null and not g.is_start
  ),
  stage_opts as (
    select o.id, o.label, o.sort from options o
    where o.workspace_id = p_workspace and o.kind = 'stage'
      and (o.active or exists (select 1 from cur c where c.stage_id = o.id))
  )
  select jsonb_build_object(
    'targets', jsonb_build_object('min_dials', t_dials, 'min_booked', t_booked),
    'stages',  coalesce((select jsonb_agg(jsonb_build_object('id', id, 'label', label) order by sort) from stage_opts), '[]'::jsonb),
    'today', jsonb_build_object(
      'pickups', (select count(*) from call_logs l where l.workspace_id = p_workspace and l.rep_id = me
                    and (l.created_at at time zone p_tz)::date = today),
      'booked',  (select count(*) from call_logs l join options o on o.id = l.outcome_id
                    where l.workspace_id = p_workspace and l.rep_id = me and o.is_success
                    and (l.created_at at time zone p_tz)::date = today),
      'signed_off', exists (select 1 from eods e where e.workspace_id = p_workspace and e.rep_id = me and e.day = today),
      'started_at', (select max(s.started_at) from day_starts s where s.workspace_id = p_workspace and s.rep_id = me
                       and (s.started_at at time zone p_tz)::date = today)
    ),
    'me', jsonb_build_object(
      'pickups',      (select count(*) from mine),
      'booked',       (select count(*) from mine where is_success),
      'prev_pickups', (select count(*) from prev where rep_id = me),
      'prev_booked',  (select count(*) from prev where rep_id = me and is_success),
      'days_active',  (select count(*) from rep_days where rep_id = me),
      'eods',         (select count(*) from eod_all where rep_id = me),
      'days_hit',     (select count(*) from hit where rep_id = me and ok),
      'avg_dials',    (select round(avg(dials)) from eod_all where rep_id = me and dials is not null),
      'lost_staged',  (select count(*) from mine where not is_success and stage_id is not null),
      'stages',       coalesce((select jsonb_object_agg(stage_id, n) from (
                         select stage_id, count(*) n from mine where not is_success and stage_id is not null
                         group by stage_id) s), '{}'::jsonb),
      'objections',   coalesce((select jsonb_agg(x) from (
                         select o.label, count(*) n from mine c join options o on o.id = c.objection_id
                         group by o.label order by count(*) desc, o.label limit 5) x), '[]'::jsonb),
      'hours',        coalesce((select jsonb_agg(x order by x.hour) from (
                         select extract(hour from lt)::int as hour, count(*) as pickups,
                                count(*) filter (where is_success) as booked
                         from mine group by 1) x), '[]'::jsonb),
      'gap_median',   (select round(percentile_cont(0.5) within group (order by gap)::numeric, 1) from gaps where rep_id = me),
      'daily',        coalesce((select jsonb_agg(x order by x.day desc) from (
                         select coalesce(c.d, e.day) as day,
                                coalesce(c.pickups, 0) as pickups, coalesce(c.booked, 0) as booked,
                                e.dials, e.energy, e.went_well, e.improve, e.blockers,
                                (e.id is not null) as signed_off,
                                (select ok from hit h where h.rep_id = me and h.day = e.day) as on_target
                         from (select lt::date as d, count(*) pickups, count(*) filter (where is_success) booked
                               from mine group by 1) c
                         full join (select * from eod_all where rep_id = me) e on e.day = c.d) x), '[]'::jsonb)
    ),
    'team', jsonb_build_object(
      'reps',          (select count(distinct rep_id) from cur),
      'rep_days',      (select count(*) from rep_days),
      'pickups',       (select count(*) from cur),
      'booked',        (select count(*) from cur where is_success),
      'prev_pickups',  (select count(*) from prev),
      'prev_booked',   (select count(*) from prev where is_success),
      'eods',          (select count(*) from eod_all),
      'days_hit',      (select count(*) from hit where ok),
      'avg_dials',     (select round(avg(dials)) from eod_all where dials is not null),
      'lost_staged',   (select count(*) from cur where not is_success and stage_id is not null),
      'stages',        coalesce((select jsonb_object_agg(stage_id, n) from (
                          select stage_id, count(*) n from cur where not is_success and stage_id is not null
                          group by stage_id) s), '{}'::jsonb),
      'gap_median',    (select round(percentile_cont(0.5) within group (order by gap)::numeric, 1) from gaps)
    )
  ) into result;

  return result;
end;
$$;
revoke execute on function public.rep_report(uuid, timestamptz, timestamptz, text) from public, anon;
grant  execute on function public.rep_report(uuid, timestamptz, timestamptz, text) to authenticated;

create or replace function public.check_quiet_reps()
returns int
language plpgsql security definer set search_path = public, extensions
as $$
declare
  r        record;
  new_id   uuid;
  raised   int := 0;
  quiet    int;
  msg      text;
begin
  for r in
    with ws as (
      select w.id, w.name,
             coalesce(s.enabled, true)        as enabled,
             coalesce(s.quiet_minutes, 30)    as qm,
             coalesce(s.start_hour, 8)        as sh,
             coalesce(s.end_hour, 20)         as eh,
             coalesce(s.tz, 'America/New_York') as tz,
             coalesce(s.slack_enabled, false) as slack_on,
             s.slack_webhook,
             coalesce(s.app_url, 'https://debrief-five-khaki.vercel.app') as app_url
      from workspaces w
      left join alert_settings s on s.workspace_id = w.id
    ),
    reps as (
      select ws.*, m.user_id as rep_id, coalesce(p.full_name, p.email) as rep_name,
             (now() at time zone ws.tz)::date as today
      from ws
      join memberships m on m.workspace_id = ws.id and m.active and m.role = 'rep'
      join profiles p on p.id = m.user_id
      where ws.enabled
        and extract(hour from now() at time zone ws.tz) >= ws.sh
        and extract(hour from now() at time zone ws.tz) <  ws.eh
    ),
    st as (
      select reps.*,
        (select max(l.created_at) from call_logs l
          where l.workspace_id = reps.id and l.rep_id = reps.rep_id
            and (l.created_at at time zone reps.tz)::date = reps.today)            as last_log,
        (select count(*) from call_logs l
          where l.workspace_id = reps.id and l.rep_id = reps.rep_id
            and (l.created_at at time zone reps.tz)::date = reps.today)            as pickups,
        (select count(*) from call_logs l join options o on o.id = l.outcome_id
          where l.workspace_id = reps.id and l.rep_id = reps.rep_id and o.is_success
            and (l.created_at at time zone reps.tz)::date = reps.today)            as booked,
        (select max(b.ended_at) from breaks b
          where b.workspace_id = reps.id and b.rep_id = reps.rep_id
            and b.ended_at > now() - interval '12 hours')                          as last_break_end,
        exists (select 1 from breaks b
          where b.workspace_id = reps.id and b.rep_id = reps.rep_id
            and b.ended_at is null and b.started_at > now() - interval '2 hours')  as on_break,
        exists (select 1 from eods e
          where e.workspace_id = reps.id and e.rep_id = reps.rep_id and e.day = reps.today) as signed_off,
        (select max(s.started_at) from day_starts s
          where s.workspace_id = reps.id and s.rep_id = reps.rep_id
            and (s.started_at at time zone reps.tz)::date = reps.today)            as started_at
      from reps
    )
    select st.*, greatest(st.last_log, st.started_at, st.last_break_end) as since
    from st
    where (st.last_log is not null or st.started_at is not null) and not st.on_break and not st.signed_off
  loop
    continue when r.since > now() - make_interval(mins => r.qm);   -- not quiet long enough
    continue when r.since < now() - interval '4 hours';             -- gone for the day
    quiet := floor(extract(epoch from now() - r.since) / 60);

    new_id := null;
    insert into alerts (workspace_id, rep_id, kind, quiet_since, minutes)
    values (r.id, r.rep_id, 'quiet', r.since, quiet)
    on conflict (workspace_id, rep_id, kind, quiet_since) do nothing
    returning id into new_id;
    continue when new_id is null;                                   -- already alerted for this spell
    raised := raised + 1;

    if r.slack_on and r.slack_webhook like 'https://hooks.slack.com/%' then
      msg := case when r.last_log is null then format(
          E':warning: *%s* started at %s and has had *no pick-ups yet* (%s min).\n<%s/w/%s|Open the %s dashboard>',
          r.rep_name, to_char(r.started_at at time zone r.tz, 'FMHH12:MI AM'), quiet, r.app_url, r.id, r.name)
        else format(
          E':warning: *%s* hasn''t logged a pick-up for *%s min* (since %s). Today: %s pick-ups · %s booked.\n<%s/w/%s|Open the %s dashboard>',
          r.rep_name, quiet, to_char(r.since at time zone r.tz, 'FMHH12:MI AM'),
          r.pickups, r.booked, r.app_url, r.id, r.name) end;
      perform net.http_post(
        url     := r.slack_webhook,
        body    := jsonb_build_object('text', msg),
        headers := '{"Content-Type": "application/json"}'::jsonb
      );
      update alerts set slack_sent = true where id = new_id;
    end if;
  end loop;
  return raised;
end;
$$;
revoke execute on function public.check_quiet_reps() from public, anon, authenticated;
