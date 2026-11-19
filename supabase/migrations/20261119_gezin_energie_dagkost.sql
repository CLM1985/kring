-- Kring: kost per dag van de stroom (afname − injectie), voor het blok "Kost per dag" op de energiepagina.
-- Per gezin en per dag: kWh afname en injectie uit de statistieken van Home Assistant (de netmeters van het
-- energiedashboard), en dezelfde kWh gewogen met de marktprijs van Frank per kwartier. De Edge Function ha-energie
-- vult de tabel (elk uur, samen met de dagprijzen: pg_cron-job energie-dagprijzen) en rekent de euro's pas uit bij
-- het lezen (actie "dagkost"):
--   afname   = FACTOR × afname_markt + (VAST + TOESLAG) × afname_kwh       (zelfde formule als evcc en de dagprijs)
--   injectie = INJ_FACTOR × injectie_markt + INJ_VAST × injectie_kwh
-- Een aangepaste formule (bv. na ijking met een factuur) geldt zo meteen voor de hele historiek.
-- Leesbaar voor elk lid van het gezin (ook tieners en kinderen), zoals de rest van de energiepagina.
-- Schrijven doet enkel ha-energie (service_role).

create table gezin.energie_dagkost (
  huishouden_id  uuid not null references gezin.huishoudens(id) on delete cascade,
  dag            date not null,                                          -- kalenderdag in Belgische tijd
  afname_kwh     numeric(9,3)  not null default 0 check (afname_kwh >= 0),
  injectie_kwh   numeric(9,3)  not null default 0 check (injectie_kwh >= 0),
  afname_markt   numeric(10,5) not null default 0,                       -- Σ kWh afname × marktprijs van dat kwartier (€)
  injectie_markt numeric(10,5) not null default 0,                       -- Σ kWh injectie × marktprijs van dat kwartier (€)
  piek_kw        numeric(6,3)  check (piek_kw >= 0),                     -- hoogste kwartiergemiddelde afname; enkel bij per = 'kwartier'
  piek_om        timestamptz,
  per            text not null check (per in ('kwartier', 'uur')),       -- resolutie van de meting (HA bewaart 5-minutenwaarden ±10 dagen)
  gemeten        smallint not null check (gemeten between 0 and 100),    -- kwartieren met een volledige meting
  verwacht       smallint not null check (verwacht between 92 and 100),  -- kwartieren in de dag (92/96/100 rond het zomeruur)
  geschat        smallint not null default 0 check (geschat >= 0),       -- kwartieren verdeeld over een gat in de meting
  zonder_prijs   smallint not null default 0 check (zonder_prijs >= 0),  -- kwartieren met verbruik maar zonder marktprijs
  bijgewerkt     timestamptz not null default now(),
  primary key (huishouden_id, dag)
);
alter table gezin.energie_dagkost enable row level security;
create policy dagkost_lezen on gezin.energie_dagkost for select to authenticated using (gezin.is_lid(huishouden_id));
grant select on gezin.energie_dagkost to authenticated;
grant select, insert, update on gezin.energie_dagkost to service_role;

-- ha-energie (service_role) moet weten voor welk gezin het de dagkost bijhoudt
grant select on gezin.energie_koppeling to service_role;
