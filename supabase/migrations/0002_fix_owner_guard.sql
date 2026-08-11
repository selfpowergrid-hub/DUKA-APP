-- =====================================================================
-- Fix: public.is_owner() could return NULL, and a NULL authorization guard
-- falls open.
-- =====================================================================
-- For a caller with no row in public.users, current_user_role() returns NULL,
-- so `NULL = 'owner'` is NULL, so `if not public.is_owner() then raise ...`
-- never fires and execution continues into the privileged branch.
--
-- In RLS policies NULL is treated as "not true" and therefore denies, so the
-- table policies were never exposed. The reachable case was create_attendant(),
-- where an anonymous caller passed the owner check and was stopped only by the
-- NOT NULL constraint on pending_invites.shop_id — defence in depth holding up
-- a guard that had already failed.
--
-- Safe to run on an existing database; changes no data.
-- =====================================================================

create or replace function public.is_owner()
returns boolean
language sql
stable
as $$
  select coalesce(public.current_user_role() = 'owner', false);
$$;

-- Belt and braces: make the guard independent of the helper's null-handling.
create or replace function public.create_attendant(p_email text, p_full_name text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_id uuid := public.current_shop_id();
begin
  if v_shop_id is null then
    raise exception 'no shop for current user';
  end if;

  if public.is_owner() is distinct from true then
    raise exception 'only an owner can add staff';
  end if;

  insert into public.pending_invites (email, shop_id, role, full_name)
  values (lower(btrim(p_email)), v_shop_id, 'attendant', p_full_name)
  on conflict (email) do update
    set shop_id = excluded.shop_id,
        role = excluded.role,
        full_name = excluded.full_name;
end;
$$;

grant execute on function public.create_attendant(text, text) to authenticated;
