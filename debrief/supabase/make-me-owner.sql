-- ============================================================================
-- Run ONCE in the Supabase SQL editor, after you've signed up in the
-- dashboard with your own account. Makes you the platform owner.
-- Then create the 7FigureRia workspace from the dashboard ("New workspace").
-- ============================================================================

update public.profiles
set is_owner = true
where email = 'YOUR_EMAIL_HERE';

-- Check it worked (should return one row with is_owner = true):
select email, is_owner from public.profiles where is_owner;
