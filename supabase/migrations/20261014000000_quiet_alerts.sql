-- ============================================================================
-- Quiet alerts: tell managers when a rep goes 30+ min (configurable) without a
-- pick-up during the shift. Runs every 5 minutes inside the database (pg_cron),
-- records each alert once per quiet spell, and optionally posts it to Slack via
-- an incoming webhook (pg_net).
--
-- A rep is checked only when they have started the day (at least one pick-up
-- today), haven't signed off, aren't on a break, it's within the team's alert
-- hours, and the quiet spell is under 4 hours (longer = they've left).
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create table if not exists public.alert_settings (
  workspace_id  uuid primary key references public.workspaces (id) on delete cascade,
  enabled       boolean not null default true,
  quiet_minutes int     not null default 30 check (quiet_minutes between 10 and 240),
  start_hour    int     not null default 8  check (start_hour between 0 and 23),
  end_hour      int     not null default 20 check (end_hour between 1 and 24),
  tz            text    not null default 'America/New_York',
  slack_enabled boolean not null default false,
  slack_webhook text    check (slack_webhook is null or slack_webhook like 'https://hooks.slack.com/%'),
  app_url       text    not null default 'https://debrief-five-khaki.vercel.app',
  updated_at    timestamptz not null default now()
);
alter table public.alert_settings enable row level security;
create policy alert_settings_select on public.alert_settings
  for select to authenticated using (public.is_manager(workspace_id));
create policy alert_settings_insert on public.alert_settings
  for insert to authenticated with check (public.is_manager(workspace_id));
create policy alert_settings_update on public.alert_settings
  for update to authenticated using (public.is_manager(workspace_id)) with check (public.is_manager(workspace_id));

create table if not exists public.alerts (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  rep_id       uuid not null references public.profiles (id) on delete cascade,
  kind         text not null default 'quiet',
  quiet_since  timestamptz not null,
  minutes      int not null,
  slack_sent   boolean not null default false,
  created_at   timestamptz not null default now()
);
create unique index if not exists alerts_once_per_spell on public.alerts (workspace_id, rep_id, kind, quiet_since);
create index if not exists alerts_ws_time_idx on public.alerts (workspace_id, created_at desc);
alter table public.alerts enable row level security;
create policy alerts_select on public.alerts
  for select to authenticated using (public.is_manager(workspace_id));

-- The check. Returns how many new alerts it raised.
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
          where e.workspace_id = reps.id and e.rep_id = reps.rep_id and e.day = reps.today) as signed_off
      from reps
    )
    select st.*, greatest(st.last_log, coalesce(st.last_break_end, st.last_log)) as since
    from st
    where st.last_log is not null and not st.on_break and not st.signed_off
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
      msg := format(
        E':warning: *%s* hasn''t logged a pick-up for *%s min* (since %s). Today: %s pick-ups · %s booked.\n<%s/w/%s|Open the %s dashboard>',
        r.rep_name, quiet, to_char(r.since at time zone r.tz, 'FMHH12:MI AM'),
        r.pickups, r.booked, r.app_url, r.id, r.name);
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

-- Every 5 minutes.
select cron.schedule('debrief-quiet-alerts', '*/5 * * * *', $$select public.check_quiet_reps()$$);
