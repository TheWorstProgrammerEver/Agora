create or replace function public.agora_health_check()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select true;
$$;

revoke all on function public.agora_health_check() from public, anon, authenticated, service_role;

grant execute on function public.agora_health_check() to service_role;
