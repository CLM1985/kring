-- Kring: wagens op de energiepagina (foto, batterij, laadtijd tot vol, vermogen).
-- Per gezin: welke wagens er zijn, hun naam in evcc en (optioneel) HA-sensoren voor batterij en bereik
-- wanneer de wagen niet aan de laadpaal hangt. Live waarden komen via de Edge Function ha-energie.
-- De foto (kleine webp als data-URL) staat hier en niet in de publieke repo; ouders kunnen ze wijzigen in de app.

create table gezin.wagens (
  id            uuid primary key default gen_random_uuid(),
  huishouden_id uuid not null references gezin.huishoudens(id) on delete cascade,
  naam          text not null check (length(naam) between 1 and 40),
  evcc_titel    text not null check (length(evcc_titel) between 1 and 60),   -- naam van het voertuig in evcc
  soc_sensor    text check (soc_sensor ~ '^sensor\.[a-z0-9_]+$'),           -- bv. sensor.volvo_xc40_batterij
  bereik_sensor text check (bereik_sensor ~ '^sensor\.[a-z0-9_]+$'),
  foto          text check (foto is null or (foto ~ '^data:image/(webp|png|jpeg);base64,' and length(foto) <= 300000)),
  volgorde      int  not null default 0,
  unique (huishouden_id, evcc_titel)
);
alter table gezin.wagens enable row level security;

create policy wagens_lezen on gezin.wagens for select to authenticated using (gezin.is_lid(huishouden_id));
create policy wagens_foto  on gezin.wagens for update to authenticated
  using (gezin.is_ouder(huishouden_id)) with check (gezin.is_ouder(huishouden_id));

grant select on gezin.wagens to authenticated;
grant update (foto) on gezin.wagens to authenticated;   -- enkel de foto; naam en sensoren via SQL

-- Wagens van het gezin met de Home Assistant (eenmalig, buiten deze publieke repo):
-- insert into gezin.wagens (huishouden_id, naam, evcc_titel, soc_sensor, bereik_sensor, volgorde)
-- values ('<huishouden-id>', '<naam>', '<voertuig in evcc>', '<sensor.…_batterij>', '<sensor.…_bereik>', 1);
