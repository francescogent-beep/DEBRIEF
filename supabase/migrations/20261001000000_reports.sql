-- ============================================================================
-- Reports: when pick-ups and bookings happen, rep scorecards with where each
-- rep loses calls vs the team, and client funnels. Managers/owner only.
-- Times are bucketed in the team timezone (p_tz). Every block also returns
-- the previous period of the same length so the page can show trends.
-- ============================================================================

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
