-- =====================================================================
-- 0015_staff_management.sql — staff roster, revocation, auto-confirm
-- =====================================================================
-- Gives the shop owner a way to:
--   1. View active attendants and pending invites in one place
--   2. Revoke pending invites or remove an attendant from the shop
--   3. Auto-confirm user emails so onboarding has zero email friction
-- =====================================================================

-- Ensure public.users stores email for easy roster display
alter table public.users
  add column if not exists email text;

-- Backfill users.email from auth.users where possible
update public.users u
   set email = au.email
  from auth.users au
 where u.id = au.id
   and u.email is null;

-- Update handle_new_user to persist email into public.users
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_id uuid;
  v_role    public.user_role;
  v_name    text;
  v_invite  public.pending_invites%rowtype;
begin
  select * into v_invite from public.pending_invites
   where email = lower(new.email);

  if found then
    v_shop_id := v_invite.shop_id;
    v_role    := v_invite.role;
    v_name    := coalesce(v_invite.full_name, new.raw_user_meta_data ->> 'full_name');
    delete from public.pending_invites where email = v_invite.email;
  else
    -- self-signup: this person is an owner, give them a shop
    insert into public.shops (name)
    values (coalesce(nullif(btrim(new.raw_user_meta_data ->> 'shop_name'), ''), 'Duka'))
    returning id into v_shop_id;
    v_role := 'owner';
    v_name := new.raw_user_meta_data ->> 'full_name';
    perform public.seed_default_units(v_shop_id);
  end if;

  insert into public.users (id, shop_id, role, full_name, email)
  values (new.id, v_shop_id, v_role, v_name, lower(new.email));

  return new;
end;
$$;

-- Owner-only: get complete staff roster (both active and pending)
create or replace function public.get_shop_staff()
returns table (
  user_id    uuid,
  email      text,
  full_name  text,
  role       text,
  created_at timestamptz,
  status     text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_id uuid := public.current_shop_id();
begin
  if public.is_owner() is distinct from true then
    raise exception 'only an owner can view staff';
  end if;

  return query
    select
      u.id as user_id,
      coalesce(u.email, '') as email,
      u.full_name,
      u.role::text,
      u.created_at,
      'active'::text as status
    from public.users u
    where u.shop_id = v_shop_id
    union all
    select
      null::uuid as user_id,
      pi.email,
      pi.full_name,
      pi.role::text,
      pi.created_at,
      'invited'::text as status
    from public.pending_invites pi
    where pi.shop_id = v_shop_id
    order by role desc, created_at asc;
end;
$$;
grant execute on function public.get_shop_staff() to authenticated;

-- Owner-only: revoke an unaccepted invitation
create or replace function public.revoke_invite(p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_id uuid := public.current_shop_id();
begin
  if public.is_owner() is distinct from true then
    raise exception 'only an owner can revoke invites';
  end if;

  delete from public.pending_invites
   where email = lower(btrim(p_email))
     and shop_id = v_shop_id;
end;
$$;
grant execute on function public.revoke_invite(text) to authenticated;

-- Owner-only: remove an attendant from the shop
create or replace function public.remove_attendant(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_id uuid := public.current_shop_id();
  v_role    public.user_role;
begin
  if public.is_owner() is distinct from true then
    raise exception 'only an owner can remove staff';
  end if;

  select role into v_role
    from public.users
   where id = p_user_id
     and shop_id = v_shop_id;

  if not found then
    raise exception 'user not found in this shop';
  end if;

  if v_role = 'owner' then
    raise exception 'cannot remove the shop owner';
  end if;

  delete from public.users
   where id = p_user_id
     and shop_id = v_shop_id;
end;
$$;
grant execute on function public.remove_attendant(uuid) to authenticated;

-- Auto-confirm trigger on auth.users if email_confirmed_at column is present
do $$
begin
  if exists (
    select from information_schema.columns
     where table_schema = 'auth'
       and table_name = 'users'
       and column_name = 'email_confirmed_at'
  ) then
    execute $trg$
      create or replace function public.auto_confirm_user()
      returns trigger
      language plpgsql
      security definer
      as $fn$
      begin
        new.email_confirmed_at := coalesce(new.email_confirmed_at, now());
        return new;
      end;
      $fn$;

      drop trigger if exists on_auth_user_before_insert on auth.users;
      create trigger on_auth_user_before_insert
        before insert on auth.users
        for each row execute function public.auto_confirm_user();
    $trg$;
  end if;
end $$;
