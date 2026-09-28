-- ============================================================================
-- DEBRIEF — initial schema
-- Workspaces (teams), roles, configurable call options, call logs, EOD
-- sign-offs, invite codes, row-level security and dashboard stats.
--
-- Privacy by design: no lead data (names, phones, assets) is ever stored.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.member_role as enum ('manager', 'rep');
create type public.option_kind as enum ('outcome', 'stage', 'objection');

-- ---------------------------------------------------------------------------
-- Profiles (one per auth user)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  full_name   text,
  is_owner    boolean not null default false,   -- platform owner: sees every workspace
  created_at  timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Workspaces & memberships
-- ---------------------------------------------------------------------------
create table public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 80),
  template    text not null default 'generic',
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);

create table public.memberships (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  role         public.member_role not null default 'rep',
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

-- ---------------------------------------------------------------------------
-- Configurable options per workspace (outcomes, stages, objections)
-- ---------------------------------------------------------------------------
create table public.options (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind         public.option_kind not null,
  label        text not null check (length(trim(label)) between 1 and 60),
  is_success   boolean not null default false,  -- outcome that counts as "booked"
  sort         int not null default 0,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create index options_ws_idx on public.options (workspace_id, kind, sort);

-- ---------------------------------------------------------------------------
-- Call logs — one row per ANSWERED call
-- ---------------------------------------------------------------------------
create table public.call_logs (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  rep_id       uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  outcome_id   uuid not null references public.options (id),
  stage_id     uuid references public.options (id),
  objection_id uuid references public.options (id),
  note         text check (note is null or length(note) <= 500),
  created_at   timestamptz not null default now()
);
create index call_logs_ws_time_idx  on public.call_logs (workspace_id, created_at desc);
create index call_logs_rep_time_idx on public.call_logs (rep_id, created_at desc);

-- Make sure every referenced option belongs to the same workspace and kind.
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
  return new;
end;
$$;

create trigger call_logs_check_options
  before insert or update on public.call_logs
  for each row execute function public.check_call_log_options();

-- ---------------------------------------------------------------------------
-- End-of-day sign-offs
-- ---------------------------------------------------------------------------
create table public.eods (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  rep_id        uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  day           date not null,
  conversations int  not null default 0,
  booked        int  not null default 0,
  went_well     text check (went_well is null or length(went_well) <= 2000),
  improve       text check (improve   is null or length(improve)   <= 2000),
  blockers      text check (blockers  is null or length(blockers)  <= 2000),
  energy        smallint check (energy between 1 and 5),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (workspace_id, rep_id, day)
);
create index eods_ws_day_idx on public.eods (workspace_id, day desc);

-- ---------------------------------------------------------------------------
-- Invite codes
-- ---------------------------------------------------------------------------
create table public.invites (
  code         text primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  role         public.member_role not null default 'rep',
  active       boolean not null default true,
  uses         int not null default 0,
  max_uses     int,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index invites_ws_idx on public.invites (workspace_id);

-- ---------------------------------------------------------------------------
-- Permission helpers (security definer so RLS policies can call them
-- without recursive policy evaluation)
-- ---------------------------------------------------------------------------
create or replace function public.is_owner()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select is_owner from profiles where id = auth.uid()), false);
$$;

create or replace function public.is_member(ws uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.is_owner() or exists (
    select 1 from memberships m
    where m.workspace_id = ws and m.user_id = auth.uid() and m.active
  );
$$;

create or replace function public.is_manager(ws uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.is_owner() or exists (
    select 1 from memberships m
    where m.workspace_id = ws and m.user_id = auth.uid() and m.active and m.role = 'manager'
  );
$$;

-- Can the current user see this profile? (own, or a rep in a team they manage)
create or replace function public.can_see_profile(pid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select pid = auth.uid() or public.is_owner() or exists (
    select 1
    from memberships mine
    join memberships theirs on theirs.workspace_id = mine.workspace_id
    where mine.user_id = auth.uid() and mine.active and mine.role = 'manager'
      and theirs.user_id = pid
  );
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.profiles    enable row level security;
alter table public.workspaces  enable row level security;
alter table public.memberships enable row level security;
alter table public.options     enable row level security;
alter table public.call_logs   enable row level security;
alter table public.eods        enable row level security;
alter table public.invites     enable row level security;

-- profiles
create policy profiles_select on public.profiles
  for select to authenticated using (public.can_see_profile(id));
create policy profiles_update_self on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
-- Users may only change their display name (never is_owner).
revoke update on public.profiles from authenticated, anon;
grant  update (full_name) on public.profiles to authenticated;

-- workspaces
create policy workspaces_select on public.workspaces
  for select to authenticated using (public.is_member(id));
create policy workspaces_update on public.workspaces
  for update to authenticated using (public.is_manager(id)) with check (public.is_manager(id));

-- memberships
create policy memberships_select on public.memberships
  for select to authenticated
  using (user_id = auth.uid() or public.is_manager(workspace_id));
create policy memberships_update on public.memberships
  for update to authenticated
  using (public.is_manager(workspace_id)) with check (public.is_manager(workspace_id));
create policy memberships_delete on public.memberships
  for delete to authenticated using (public.is_manager(workspace_id));

-- options
create policy options_select on public.options
  for select to authenticated using (public.is_member(workspace_id));
create policy options_insert on public.options
  for insert to authenticated with check (public.is_manager(workspace_id));
create policy options_update on public.options
  for update to authenticated
  using (public.is_manager(workspace_id)) with check (public.is_manager(workspace_id));

-- call_logs
create policy call_logs_select on public.call_logs
  for select to authenticated
  using (rep_id = auth.uid() or public.is_manager(workspace_id));
create policy call_logs_insert on public.call_logs
  for insert to authenticated
  with check (rep_id = auth.uid() and public.is_member(workspace_id));
-- Reps can undo/fix their own log for 15 minutes.
create policy call_logs_update_own on public.call_logs
  for update to authenticated
  using (rep_id = auth.uid() and created_at > now() - interval '15 minutes')
  with check (rep_id = auth.uid());
create policy call_logs_delete_own on public.call_logs
  for delete to authenticated
  using (rep_id = auth.uid() and created_at > now() - interval '15 minutes');

-- eods
create policy eods_select on public.eods
  for select to authenticated
  using (rep_id = auth.uid() or public.is_manager(workspace_id));
create policy eods_insert on public.eods
  for insert to authenticated
  with check (rep_id = auth.uid() and public.is_member(workspace_id));
create policy eods_update_own on public.eods
  for update to authenticated
  using (rep_id = auth.uid()) with check (rep_id = auth.uid());

-- invites
create policy invites_select on public.invites
  for select to authenticated using (public.is_manager(workspace_id));
create policy invites_insert on public.invites
  for insert to authenticated with check (public.is_manager(workspace_id));
create policy invites_update on public.invites
  for update to authenticated
  using (public.is_manager(workspace_id)) with check (public.is_manager(workspace_id));

-- ---------------------------------------------------------------------------
-- Templates: default options for a new workspace
-- ---------------------------------------------------------------------------
create or replace function public._seed_options(ws uuid, tpl text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  outcomes   text[] := array['Booked', 'Callback', 'Not interested', 'Not qualified', 'Hung up'];
  stages     text[] := array['Opener', 'Pitch', 'Discovery', 'Qualification', 'Booking'];
  objections text[];
  i int;
begin
  if tpl = '7figureria' then
    objections := array[
      'Already have an advisor',
      'Not interested / don''t need help',
      'Send me something',
      'Is this a scam?',
      'Too busy / bad time',
      'Need to talk to spouse',
      'Not enough assets',
      'Don''t remember signing up',
      'Doesn''t want to be sold',
      'Other'
    ];
  else
    objections := array[
      'Not interested',
      'Send me an email',
      'Already have someone',
      'Bad timing',
      'No budget',
      'Need to check with partner',
      'Don''t remember signing up',
      'Other'
    ];
  end if;

  for i in 1 .. array_length(outcomes, 1) loop
    insert into options (workspace_id, kind, label, is_success, sort)
    values (ws, 'outcome', outcomes[i], outcomes[i] = 'Booked', i);
  end loop;
  for i in 1 .. array_length(stages, 1) loop
    insert into options (workspace_id, kind, label, sort) values (ws, 'stage', stages[i], i);
  end loop;
  for i in 1 .. array_length(objections, 1) loop
    insert into options (workspace_id, kind, label, sort) values (ws, 'objection', objections[i], i);
  end loop;
end;
$$;
revoke execute on function public._seed_options(uuid, text) from public, anon, authenticated;

create or replace function public._random_code()
returns text
language sql volatile
as $$
  -- 8 chars, no ambiguous characters (0/O, 1/I/L)
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', (floor(random() * 31) + 1)::int, 1), '')
  from generate_series(1, 8);
$$;

-- ---------------------------------------------------------------------------
-- RPC: create a workspace (owner only for now; opens up when selling)
-- Returns the new workspace id. Creator becomes manager; a rep and a manager
-- invite code are generated.
-- ---------------------------------------------------------------------------
create or replace function public.create_workspace(p_name text, p_template text default 'generic')
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  ws uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not public.is_owner() then raise exception 'Only the platform owner can create workspaces'; end if;

  insert into workspaces (name, template, created_by)
  values (trim(p_name), coalesce(p_template, 'generic'), auth.uid())
  returning id into ws;

  perform public._seed_options(ws, coalesce(p_template, 'generic'));

  insert into memberships (workspace_id, user_id, role) values (ws, auth.uid(), 'manager');
  insert into invites (code, workspace_id, role, created_by) values (public._random_code(), ws, 'rep', auth.uid());
  insert into invites (code, workspace_id, role, created_by) values (public._random_code(), ws, 'manager', auth.uid());
  return ws;
end;
$$;
revoke execute on function public.create_workspace(text, text) from public, anon;
grant  execute on function public.create_workspace(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: create another invite code for a workspace (managers)
-- ---------------------------------------------------------------------------
create or replace function public.create_invite(p_workspace uuid, p_role public.member_role default 'rep')
returns text
language plpgsql security definer set search_path = public
as $$
declare
  c text;
begin
  if not public.is_manager(p_workspace) then raise exception 'Not allowed'; end if;
  c := public._random_code();
  insert into invites (code, workspace_id, role, created_by) values (c, p_workspace, p_role, auth.uid());
  return c;
end;
$$;
revoke execute on function public.create_invite(uuid, public.member_role) from public, anon;
grant  execute on function public.create_invite(uuid, public.member_role) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: join a workspace with an invite code
-- ---------------------------------------------------------------------------
create or replace function public.join_workspace(p_code text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  inv invites%rowtype;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;

  select * into inv from invites
  where code = upper(trim(p_code)) and active
  for update;

  if not found then raise exception 'Invite code not found or no longer active'; end if;
  if inv.max_uses is not null and inv.uses >= inv.max_uses then
    raise exception 'This invite code has been used up';
  end if;

  insert into memberships (workspace_id, user_id, role)
  values (inv.workspace_id, auth.uid(), inv.role)
  on conflict (workspace_id, user_id) do update
    set active = true,
        -- never downgrade an existing manager through a rep code
        role = case when memberships.role = 'manager' then 'manager'::public.member_role
                    else excluded.role end;

  update invites set uses = uses + 1 where code = inv.code;
  return inv.workspace_id;
end;
$$;
revoke execute on function public.join_workspace(text) from public, anon;
grant  execute on function public.join_workspace(text) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: dashboard stats for a workspace and time window (managers/owner)
-- Aggregated server-side so it scales past the 1,000-row API limit.
-- ---------------------------------------------------------------------------
create or replace function public.workspace_stats(p_workspace uuid, p_from timestamptz, p_to timestamptz, p_tz text default 'America/New_York')
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.is_manager(p_workspace) then raise exception 'Not allowed'; end if;

  with logs as (
    select l.*, o.is_success
    from call_logs l
    join options o on o.id = l.outcome_id
    where l.workspace_id = p_workspace and l.created_at >= p_from and l.created_at < p_to
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
      (select count(*) from eods e
        where e.workspace_id = p_workspace and e.rep_id = t.user_id
          and e.day >= (p_from at time zone p_tz)::date
          and e.day <  (p_to   at time zone p_tz)::date) as eods,
      (select round(avg(e.energy)::numeric, 1) from eods e
        where e.workspace_id = p_workspace and e.rep_id = t.user_id
          and e.day >= (p_from at time zone p_tz)::date
          and e.day <  (p_to   at time zone p_tz)::date) as avg_energy,
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
                 'active_reps', count(distinct rep_id))
               from logs),
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
