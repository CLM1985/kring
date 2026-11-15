-- Kring: tijdsvenster voor de laadpaal. Buiten het venster zet Kring evcc op Uit, bij de start weer op de gekozen modus
-- (Slim of Snel). Een pg_cron-job kijkt elke minuut of er een overgang is en roept dan de Edge Function ha-energie aan
-- (actie "tick"), die evcc via Home Assistant stuurt. Werkt dus ook als niemand de app open heeft.

create table gezin.laadvenster (
  huishouden_id   uuid primary key references gezin.huishoudens on delete cascade,
  actief          boolean not null default false,
  van             time not null default '22:00',
  tot             time not null default '07:00',
  modus           text not null default 'smart' check (modus in ('smart', 'now')),   -- modus binnen het venster
  status          text check (status in ('binnen', 'buiten')),                       -- laatst toegepast door Kring
  laatste_poging  timestamptz,
  gewijzigd       timestamptz not null default now(),
  gewijzigd_door  uuid default auth.uid()
);
alter table gezin.laadvenster enable row level security;
create policy laadvenster_lezen on gezin.laadvenster for select to authenticated using (gezin.is_lid(huishouden_id));
grant select on gezin.laadvenster to authenticated;

-- Geheim token waarmee de cron-job zich bij ha-energie aanmeldt (enkel leesbaar voor postgres en service_role)
create table gezin.laadvenster_tick (id int primary key default 1 check (id = 1), token text not null default encode(extensions.gen_random_bytes(24), 'hex'), url text not null, apikey text not null);
alter table gezin.laadvenster_tick enable row level security;
revoke all on gezin.laadvenster_tick from public, anon, authenticated;

-- Binnen het venster? Over middernacht (22:00–07:00) wordt correct behandeld. Tijd in Belgische tijd.
create function gezin.laadvenster_binnen(p_van time, p_tot time, p_op timestamptz default now())
returns boolean language sql immutable as $$
  select case when p_van = p_tot then true
              when p_van < p_tot then (p_op at time zone 'Europe/Brussels')::time >= p_van and (p_op at time zone 'Europe/Brussels')::time < p_tot
              else (p_op at time zone 'Europe/Brussels')::time >= p_van or (p_op at time zone 'Europe/Brussels')::time < p_tot end;
$$;

-- Venster instellen (enkel wie mag sturen: beheerder of lid). Status leeg = ha-energie past meteen toe.
create function gezin.laadvenster_zet(p_actief boolean, p_van time, p_tot time)
returns void language plpgsql security definer set search_path = '' as $$
declare t jsonb := gezin.energie_toegang();
begin
  if not coalesce((t->>'sturen')::boolean, false) then raise exception 'Geen toegang om de laadpaal te sturen'; end if;
  insert into gezin.laadvenster (huishouden_id, actief, van, tot, status, gewijzigd, gewijzigd_door)
  values ((t->>'huishouden')::uuid, p_actief, p_van, p_tot, null, now(), auth.uid())
  on conflict (huishouden_id) do update set actief = excluded.actief, van = excluded.van, tot = excluded.tot, status = null, laatste_poging = null, gewijzigd = now(), gewijzigd_door = auth.uid();
  insert into gezin.energie_log (huishouden_id, actie, waarde)
  values ((t->>'huishouden')::uuid, 'laadvenster', case when p_actief then to_char(p_van, 'HH24:MI') || '-' || to_char(p_tot, 'HH24:MI') else 'uit' end);
end; $$;

-- Gekozen modus binnen het venster (Slim of Snel) onthouden
create function gezin.laadvenster_modus(p_modus text)
returns void language plpgsql security definer set search_path = '' as $$
declare t jsonb := gezin.energie_toegang();
begin
  if not coalesce((t->>'sturen')::boolean, false) then raise exception 'Geen toegang om de laadpaal te sturen'; end if;
  if p_modus not in ('smart', 'now') then return; end if;
  insert into gezin.laadvenster (huishouden_id, modus) values ((t->>'huishouden')::uuid, p_modus)
  on conflict (huishouden_id) do update set modus = excluded.modus;
end; $$;

-- Voor ha-energie (service_role): welke vensters moeten nu toegepast worden, en status bijwerken
create function gezin.laadvenster_te_doen(p_token text)
returns table (huishouden_id uuid, actief boolean, van time, tot time, modus text, binnen boolean)
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from gezin.laadvenster_tick k where k.token = p_token) then raise exception 'Ongeldig token'; end if;
  return query select v.huishouden_id, v.actief, v.van, v.tot, v.modus, gezin.laadvenster_binnen(v.van, v.tot)
    from gezin.laadvenster v join gezin.energie_koppeling k on k.huishouden_id = v.huishouden_id and k.actief
   where v.actief and v.status is distinct from (case when gezin.laadvenster_binnen(v.van, v.tot) then 'binnen' else 'buiten' end);
end; $$;
create function gezin.laadvenster_toegepast(p_huishouden uuid, p_status text)
returns void language sql security definer set search_path = '' as $$
  update gezin.laadvenster set status = p_status, laatste_poging = now() where huishouden_id = p_huishouden;
$$;
revoke all on function gezin.laadvenster_zet(boolean, time, time), gezin.laadvenster_modus(text) from public, anon;
grant execute on function gezin.laadvenster_zet(boolean, time, time), gezin.laadvenster_modus(text) to authenticated;
revoke all on function gezin.laadvenster_te_doen(text), gezin.laadvenster_toegepast(uuid, text) from public, anon, authenticated;
grant execute on function gezin.laadvenster_te_doen(text), gezin.laadvenster_toegepast(uuid, text) to service_role;

-- Elke minuut: is er een overgang (of een nieuw venster), roep dan ha-energie aan. Hoogstens om de 3 minuten opnieuw proberen.
create function gezin.laadvenster_cron()
returns void language plpgsql security definer set search_path = '' as $$
declare k record;
begin
  if not exists (select 1 from gezin.laadvenster v
                  where v.actief and v.status is distinct from (case when gezin.laadvenster_binnen(v.van, v.tot) then 'binnen' else 'buiten' end)
                    and (v.laatste_poging is null or v.laatste_poging < now() - interval '3 minutes')) then return; end if;
  select * into k from gezin.laadvenster_tick where id = 1;
  if k is null then return; end if;
  update gezin.laadvenster set laatste_poging = now()
   where actief and status is distinct from (case when gezin.laadvenster_binnen(van, tot) then 'binnen' else 'buiten' end);
  perform net.http_post(url := k.url, body := jsonb_build_object('actie', 'tick', 'token', k.token),
                        headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', k.apikey));
end; $$;
revoke all on function gezin.laadvenster_cron() from public, anon, authenticated;

-- Eenmalig, buiten de publieke repo: url en publishable key van het project invullen
-- insert into gezin.laadvenster_tick (url, apikey) values ('https://<project>.supabase.co/functions/v1/ha-energie', '<publishable key>');
select cron.schedule('laadvenster', '* * * * *', 'select gezin.laadvenster_cron()');

-- Laadstroom wijzigen wordt ook gelogd
create or replace function gezin.energie_registreer(p_actie text, p_waarde text)
returns void language plpgsql security definer set search_path = '' as $$
declare t jsonb := gezin.energie_toegang();
begin
  if not coalesce((t->>'sturen')::boolean, false) then raise exception 'Geen toegang om de laadpaal te sturen'; end if;
  if p_actie not in ('laadmodus', 'laadstroom') then raise exception 'Onbekende actie'; end if;
  insert into gezin.energie_log (huishouden_id, actie, waarde) values ((t->>'huishouden')::uuid, p_actie, left(p_waarde, 40));
end; $$;

-- ===== Bewaking en "Toch laden" (zelfde dag toegevoegd) =====
-- Buiten het venster kijkt Kring om de 5 minuten of evcc nog op Uit staat en zet het anders terug.
-- Bewust buiten het venster laden gaat via "Toch laden" in Kring: dan laat Kring de paal met rust tot uitzondering_tot.
alter table gezin.laadvenster
  add column uitzondering_tot  timestamptz,
  add column uitzondering_door uuid,
  add column laatste_controle  timestamptz;

drop function gezin.laadvenster_te_doen(text);
create function gezin.laadvenster_te_doen(p_token text)
returns table (huishouden_id uuid, modus text, binnen boolean, controle boolean)
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from gezin.laadvenster_tick k where k.token = p_token) then raise exception 'Ongeldig token'; end if;
  return query
  select v.huishouden_id, v.modus, b.binnen,
         (v.status is not distinct from (case when b.binnen then 'binnen' else 'buiten' end))
    from gezin.laadvenster v
    join gezin.energie_koppeling k on k.huishouden_id = v.huishouden_id and k.actief
    cross join lateral (select gezin.laadvenster_binnen(v.van, v.tot) as binnen) b
   where v.actief and (v.uitzondering_tot is null or v.uitzondering_tot <= now())
     and (v.status is distinct from (case when b.binnen then 'binnen' else 'buiten' end)
          or (not b.binnen and (v.laatste_controle is null or v.laatste_controle < now() - interval '4 minutes 30 seconds')));
end; $$;
revoke all on function gezin.laadvenster_te_doen(text) from public, anon, authenticated;
grant execute on function gezin.laadvenster_te_doen(text) to service_role;

create or replace function gezin.laadvenster_toegepast(p_huishouden uuid, p_status text)
returns void language sql security definer set search_path = '' as $$
  update gezin.laadvenster set status = p_status, laatste_poging = now(), laatste_controle = now(),
         uitzondering_tot = case when uitzondering_tot <= now() then null else uitzondering_tot end
   where huishouden_id = p_huishouden;
$$;

create function gezin.laadvenster_toch(p_uren numeric)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare t jsonb := gezin.energie_toegang(); v gezin.laadvenster; tot_ts timestamptz;
begin
  if not coalesce((t->>'sturen')::boolean, false) then raise exception 'Geen toegang om de laadpaal te sturen'; end if;
  select * into v from gezin.laadvenster where huishouden_id = (t->>'huishouden')::uuid;
  if v is null or not v.actief then raise exception 'Er is geen laadvenster actief'; end if;
  if p_uren = 0 then tot_ts := null;
  elsif p_uren is null then
    tot_ts := ((now() at time zone 'Europe/Brussels')::date + v.van) at time zone 'Europe/Brussels';
    if tot_ts <= now() then tot_ts := tot_ts + interval '1 day'; end if;
  else tot_ts := now() + make_interval(mins => least(greatest(p_uren, 0.5), 24) * 60); end if;
  update gezin.laadvenster set uitzondering_tot = tot_ts, uitzondering_door = auth.uid(), status = null, laatste_poging = null
   where huishouden_id = v.huishouden_id;
  insert into gezin.energie_log (huishouden_id, actie, waarde)
  values (v.huishouden_id, 'toch laden', coalesce(to_char(tot_ts at time zone 'Europe/Brussels', 'DD/MM HH24:MI'), 'gestopt'));
  return tot_ts;
end; $$;
revoke all on function gezin.laadvenster_toch(numeric) from public, anon;
grant execute on function gezin.laadvenster_toch(numeric) to authenticated;

create or replace function gezin.laadvenster_cron()
returns void language plpgsql security definer set search_path = '' as $$
declare k record;
begin
  if not exists (
    select 1 from gezin.laadvenster v cross join lateral (select gezin.laadvenster_binnen(v.van, v.tot) as binnen) b
     where v.actief and (v.uitzondering_tot is null or v.uitzondering_tot <= now())
       and (v.laatste_poging is null or v.laatste_poging < now() - interval '50 seconds')
       and (v.status is distinct from (case when b.binnen then 'binnen' else 'buiten' end)
            or (not b.binnen and (v.laatste_controle is null or v.laatste_controle < now() - interval '4 minutes 30 seconds')))) then return; end if;
  select * into k from gezin.laadvenster_tick where id = 1;
  if k is null then return; end if;
  update gezin.laadvenster set laatste_poging = now() where actief;
  perform net.http_post(url := k.url, body := jsonb_build_object('actie', 'tick', 'token', k.token),
                        headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', k.apikey));
end; $$;
revoke all on function gezin.laadvenster_cron() from public, anon, authenticated;

create function gezin.laadvenster_bewaakt(p_huishouden uuid, p_was text)
returns void language sql security definer set search_path = '' as $$
  insert into gezin.energie_log (huishouden_id, user_id, actie, waarde) values (p_huishouden, '00000000-0000-0000-0000-000000000000', 'bewaking', 'stond op ' || left(p_was, 20) || ', terug op Uit');
$$;
revoke all on function gezin.laadvenster_bewaakt(uuid, text) from public, anon, authenticated;
grant execute on function gezin.laadvenster_bewaakt(uuid, text) to service_role;
