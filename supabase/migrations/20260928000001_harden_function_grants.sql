-- Trigger-only functions: nobody should call these via the API.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.check_call_log_options() from public, anon, authenticated;

-- Permission helpers: needed by signed-in users (RLS), never by anonymous visitors.
revoke execute on function public.is_owner() from public, anon;
revoke execute on function public.is_member(uuid) from public, anon;
revoke execute on function public.is_manager(uuid) from public, anon;
revoke execute on function public.can_see_profile(uuid) from public, anon;
grant execute on function public.is_owner() to authenticated;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.is_manager(uuid) to authenticated;
grant execute on function public.can_see_profile(uuid) to authenticated;

-- Internal helper.
alter function public._random_code() set search_path = public;
revoke execute on function public._random_code() from public, anon, authenticated;
