-- Kring: rol 'tiener' = lid met eigen account, maar zonder toegang tot het budget.
-- Uitnodigingen per e-mailadres bepalen de rol bij het aansluiten.

alter table gezin.leden drop constraint leden_rol_check;
alter table gezin.leden add constraint leden_rol_check check (rol in ('beheerder', 'lid', 'kind', 'tiener'));

-- Mag de aangemelde gebruiker het budget van dit gezin zien?
create function gezin.ziet_budget(p_huishouden uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from gezin.leden
                  where huishouden_id = p_huishouden and user_id = (select auth.uid())
                    and rol in ('beheerder', 'lid'));
$$;
revoke all on function gezin.ziet_budget(uuid) from public, anon;
grant execute on function gezin.ziet_budget(uuid) to authenticated;

-- Budget: enkel voor beheerder en lid (niet voor tiener).
do $do$
declare d text;
begin
  d := pg_get_functiondef('gezin.budget_gegevens(uuid)'::regprocedure);
  if position('if not gezin.is_lid(p_huishouden) then raise exception ''Geen toegang tot dit gezin''; end if;' in d) = 0 then
    raise exception 'budget_gegevens: toegangscontrole niet gevonden';
  end if;
  d := replace(d, 'if not gezin.is_lid(p_huishouden) then raise exception ''Geen toegang tot dit gezin''; end if;',
                  'if not gezin.ziet_budget(p_huishouden) then raise exception ''Geen toegang tot het budget''; end if;');
  execute d;
end
$do$;

drop policy budget_bron_lezen on gezin.budget_bron;
create policy budget_bron_lezen on gezin.budget_bron for select to authenticated using (gezin.ziet_budget(huishouden_id));

-- Uitnodigingen: welke rol krijgt wie bij het aansluiten (enkel via functies, niet leesbaar voor de app).
create table gezin.uitnodigingen (
  huishouden_id uuid not null references gezin.huishoudens(id) on delete cascade,
  email         text not null check (email = lower(trim(email))),
  rol           text not null default 'lid' check (rol in ('lid', 'tiener')),
  aangemaakt    timestamptz not null default now(),
  primary key (huishouden_id, email)
);
alter table gezin.uitnodigingen enable row level security;
revoke all on gezin.uitnodigingen from public, anon, authenticated;

create or replace function gezin.aansluiten(p_code text, p_weergavenaam text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_h uuid; v_rol text;
begin
  if (select auth.uid()) is null then raise exception 'Niet aangemeld'; end if;
  select id into v_h from gezin.huishoudens
   where uitnodigcode = upper(trim(p_code));
  if v_h is null then raise exception 'Onbekende uitnodigcode'; end if;
  if exists (select 1 from gezin.leden
             where user_id = (select auth.uid()) and huishouden_id <> v_h) then
    raise exception 'Je bent al lid van een ander gezin';
  end if;
  select rol into v_rol from gezin.uitnodigingen
   where huishouden_id = v_h and email = (select lower(u.email) from auth.users u where u.id = (select auth.uid()));
  insert into gezin.leden (huishouden_id, user_id, naam, rol)
  values (v_h, (select auth.uid()), trim(p_weergavenaam), coalesce(v_rol, 'lid'))
  on conflict (huishouden_id, user_id) do nothing;
  return v_h;
end;
$$;

-- Beheerder zet budgettoegang aan of uit voor een lid met account.
create function gezin.zet_budgettoegang(p_lid uuid, p_ziet boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v gezin.leden;
begin
  select * into v from gezin.leden where id = p_lid;
  if not found or not gezin.is_beheerder(v.huishouden_id) then raise exception 'Enkel de beheerder kan dit instellen'; end if;
  if v.rol not in ('lid', 'tiener') then raise exception 'Kan enkel voor een gewoon lid'; end if;
  update gezin.leden set rol = case when p_ziet then 'lid' else 'tiener' end where id = p_lid;
end;
$$;
revoke all on function gezin.zet_budgettoegang(uuid, boolean) from public, anon;
grant execute on function gezin.zet_budgettoegang(uuid, boolean) to authenticated;
