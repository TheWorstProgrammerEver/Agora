create or replace function public.current_auth_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(trim(coalesce((
    select users.email
    from auth.users as users
    where users.id = auth.uid()
  ), '')));
$$;

revoke execute on function public.current_auth_email() from public, anon, authenticated;
grant execute on function public.current_auth_email() to authenticated;
