-- Daily targets: minimum dials and booked appointments per rep per day.
-- Reps report dials in their EOD; booked is counted from their call logs.

alter table public.workspaces
  add column min_dials  int default 500 check (min_dials  is null or min_dials  between 0 and 5000),
  add column min_booked int default 5   check (min_booked is null or min_booked between 0 and 500);

alter table public.eods
  add column dials int check (dials is null or dials between 0 and 5000);

create or replace function public.workspace_stats(p_workspace uuid, p_from timestamptz, p_to timestamptz, p_tz text default 'America/New_York')
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

  with logs as (
    select l.*, o.is_success
    from call_logs l
    join options o on o.id = l.outcome_id
    where l.workspace_id = p_workspace and l.created_at >= p_from and l.created_at < p_to
  ),
  day_eods as (
    select e.* from eods e
    where e.workspace_id = p_workspace
      and e.day >= (p_from at time zone p_tz)::date
      and e.day <  (p_to   at time zone p_tz)::date
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
      (select count(*) from day_eods e where e.rep_id = t.user_id)                     as eods,
      (select round(avg(e.energy)::numeric, 1) from day_eods e where e.rep_id = t.user_id) as avg_energy,
      (select coalesce(sum(e.dials), 0) from day_eods e where e.rep_id = t.user_id)   as dials,
      (select count(*) from day_eods e where e.rep_id = t.user_id
         and (t_dials is null or coalesce(e.dials, 0) >= t_dials)
         and (t_booked is null or e.booked >= t_booked))                             as days_hit,
      (select jsonb_object_agg(s.stage_id, s.n) from (
          select l2.stage_id, count(*) n from logs l2
          where l2.rep_id = t.user_id and l2.stage_id is not null
          group by l2.stage_id) s)                  as stages
    from team t
    left join logs l on l.rep_id = t.user_id
    group by t.user_id, t.full_name, t.email, t.role
  )
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
                 'conversations', count(*),
                 'booked', count(*) filter (where is_success),
                 'active_reps', count(distinct rep_id),
                 'dials', (select coalesce(sum(dials), 0) from day_eods))
               from logs),
    'targets', jsonb_build_object('min_dials', t_dials, 'min_booked', t_booked),
    'reps', coalesce((select jsonb_agg(to_jsonb(r) order by r.booked desc, r.conversations desc) from reps r), '[]'::jsonb),
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
revoke execute on function public.workspace_stats(uuid, timestamptz, timestamptz, text) from public, anon;
grant  execute on function public.workspace_stats(uuid, timestamptz, timestamptz, text) to authenticated;
