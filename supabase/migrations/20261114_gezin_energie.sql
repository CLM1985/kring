-- Kring: energiepagina (evcc via Home Assistant).
-- Welk gezin hoort bij de Home Assistant van de Edge Function ha-energie, wie mag de laadmodus wijzigen,
-- en een logboek van elke wijziging vanuit Kring. De app leest of schrijft deze tabellen nooit rechtstreeks.

create table gezin.energie_koppeling (
  huishouden_id uuid primary key references gezin.huishoudens(id) on delete cascade,
  actief        boolean not null default true,
  aangemaakt    timestamptz not null default now()
);
alter table gezin.energie_koppeling enable row level security;   -- geen policies: enkel via functies

create table gezin.energie_log (
  id            bigint generated always as identity primary key,
  huishouden_id uuid not null references gezin.huishoudens(id) on delete cascade,
  user_id       uuid not null default auth.uid(),
  actie         text not null,
  waarde        text,
  tijdstip      timestamptz not null default now()
);
alter table gezin.energie_log enable row level security;
create policy energie_log_lezen on gezin.energie_log for select to authenticated using (gezin.is_lid(huishouden_id));
grant select on gezin.energie_log to authenticated;

-- Wat mag de aangemelde gebruiker met de energiepagina?
-- lezen: lid van een gekoppeld gezin. sturen: daarbovenop rol beheerder of lid (geen tiener of kind).
create function gezin.energie_toegang()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object('huishouden', l.huishouden_id, 'lezen', true, 'sturen', l.rol in ('beheerder', 'lid'))
       from gezin.leden l join gezin.energie_koppeling k on k.huishouden_id = l.huishouden_id and k.actief
      where l.user_id = (select auth.uid())
      order by (l.rol in ('beheerder', 'lid')) desc
      limit 1),
    jsonb_build_object('lezen', false, 'sturen', false));
$$;

-- Registreert een stuuractie en weigert als de gebruiker niet mag sturen.
create function gezin.energie_registreer(p_actie text, p_waarde text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare t jsonb := gezin.energie_toegang();
begin
  if not coalesce((t->>'sturen')::boolean, false) then raise exception 'Geen toegang om de laadpaal te sturen'; end if;
  if p_actie not in ('laadmodus') then raise exception 'Onbekende actie'; end if;
  insert into gezin.energie_log (huishouden_id, actie, waarde) values ((t->>'huishouden')::uuid, p_actie, left(p_waarde, 40));
end;
$$;

revoke all on function gezin.energie_toegang(), gezin.energie_registreer(text, text) from public, anon;
grant execute on function gezin.energie_toegang(), gezin.energie_registreer(text, text) to authenticated;

-- Het gezin met de Home Assistant (eenmalig, buiten deze publieke repo):
-- insert into gezin.energie_koppeling (huishouden_id) values ('<huishouden-id>');
