-- ============================================================================
-- My stats: a rep's own numbers plus anonymous team averages to compare with.
-- Any member can call it, and it only ever returns the caller's own rows
-- (auth.uid()) plus team-wide aggregates, never another rep's name or numbers.
-- ============================================================================

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
  gaps0 as (
    select rep_id, created_at, lt,
           lag(created_at) over (partition by rep_id, lt::date order by created_at) as prev_at
    from cur
  ),
  gaps as (
    select g.rep_id,
      greatest(0, extract(epoch from g.created_at - g.prev_at)
        - coalesce((select sum(extract(epoch from least(b.e, g.created_at) - greatest(b.s, g.prev_at)))
                    from brk b where b.rep_id = g.rep_id and b.s < g.created_at and b.e > g.prev_at), 0)) / 60.0 as gap
    from gaps0 g where g.prev_at is not null
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
      'signed_off', exists (select 1 from eods e where e.workspace_id = p_workspace and e.rep_id = me and e.day = today)
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
