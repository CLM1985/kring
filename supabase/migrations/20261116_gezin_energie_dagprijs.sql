-- Kring: historiek van de dagprijs (all-in, €/kWh) om een dag als goedkoop / normaal / duur in te delen.
-- Bron: publieke marktprijzen van Frank (BE, per kwartier), omgerekend met dezelfde formule als evcc
-- (1,1321 × markt + 0,0159 + 0,1205). De Edge Function ha-energie vult ontbrekende dagen aan (actie "dagprijzen"),
-- elk uur via pg_cron; de eerste keren ook de inhaalslag sinds 1/1/2026 (40 dagen per oproep).
-- Prijzen zijn voor iedereen gelijk: geen huishouden_id, lezen voor elke aangemelde gebruiker, schrijven enkel service_role.

create table gezin.energie_dagprijs (
  dag         date primary key,
  gem         numeric(7,5) not null,     -- gemiddelde all-in prijs van de dag
  min         numeric(7,5) not null,
  max         numeric(7,5) not null,
  kwartieren  int not null check (kwartieren between 1 and 100),
  bijgewerkt  timestamptz not null default now()
);
alter table gezin.energie_dagprijs enable row level security;
create policy dagprijs_lezen on gezin.energie_dagprijs for select to authenticated using (true);
grant select on gezin.energie_dagprijs to authenticated;
grant select, insert, update on gezin.energie_dagprijs to service_role;

-- Elk uur (om :07) ontbrekende dagen ophalen; hergebruikt url, token en apikey van de laadvenster-tick.
select cron.schedule('energie-dagprijzen', '7 * * * *', $$
  select net.http_post(url := k.url, body := jsonb_build_object('actie', 'dagprijzen', 'token', k.token),
                       headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', k.apikey))
    from gezin.laadvenster_tick k where k.id = 1
$$);
