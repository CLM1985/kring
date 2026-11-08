-- =====================================================================
-- Kring – schema gezin, R2 Agenda: agenda's, afspraken, taken met deadline,
-- verjaardagen, gezinsleden zonder account, externe agenda's (ICS)
-- Versie 1 · 8/11/2026 (nog niet uitgevoerd; na 20261107_gezin_menu.sql, eerst op een branch)
--
-- Additief: enkel schema "gezin". Raakt "ynab" niet.
-- Feestdagen en schoolvakanties worden in de app berekend (geen tabel nodig).
-- =====================================================================

begin;

-- ---------- Gezinsleden: kleur, leden zonder account ------------------
alter table gezin.leden add column kleur text not null default '#5b6a64';

-- Lid zonder account toevoegen (bv. kind). Enkel voor leden van het gezin.
create function gezin.voeg_lid_toe(p_huishouden uuid, p_naam text, p_kleur text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v uuid;
begin
  if not gezin.is_lid(p_huishouden) then raise exception 'Geen toegang tot dit gezin'; end if;
  insert into gezin.leden (huishouden_id, user_id, naam, kleur)
  values (p_huishouden, null, trim(p_naam), coalesce(p_kleur, '#5b6a64')) returning id into v;
  return v;
end;
$$;

-- ---------- Agenda's --------------------------------------------------
create table gezin.kalenders (
  id            uuid primary key default gen_random_uuid(),
  huishouden_id uuid not null references gezin.huishoudens on delete cascade,
  naam          text not null check (length(trim(naam)) between 1 and 60),
  kleur         text not null default '#2f7a5b',
  soort         text not null default 'eigen' check (soort in ('eigen', 'ics')),
  ics_url       text,                          -- bij abonnement op een externe agenda
  laatst_opgehaald timestamptz,
  aangemaakt    timestamptz not null default now()
);

-- Standaardagenda's bij een nieuw gezin
create function gezin.standaard_kalenders()
returns trigger language plpgsql set search_path = ''
as $$
begin
  insert into gezin.kalenders (huishouden_id, naam, kleur) values (new.id, 'Gezin', '#2f7a5b');
  return new;
end;
$$;
create trigger huishouden_kalenders after insert on gezin.huishoudens
  for each row execute function gezin.standaard_kalenders();

-- ---------- Afspraken -------------------------------------------------
-- Herhaling als kolommen: freq dag/week/maand/jaar, interval, weekdagen (1=ma … 7=zo), tot en met.
create table gezin.afspraken (
  id              uuid primary key default gen_random_uuid(),
  huishouden_id   uuid not null references gezin.huishoudens on delete cascade,
  kalender_id     uuid not null references gezin.kalenders on delete cascade,
  titel           text not null check (length(trim(titel)) between 1 and 200),
  hele_dag        boolean not null default false,
  datum           date not null,
  datum_tot       date check (datum_tot is null or datum_tot >= datum),
  start_tijd      time,
  eind_tijd       time,
  plaats          text,
  notitie         text,
  herinnering_min int check (herinnering_min between 0 and 10080),
  deelnemers      uuid[] not null default '{}',      -- gezin.leden.id
  herh_freq       text check (herh_freq in ('dag', 'week', 'maand', 'jaar')),
  herh_interval   smallint check (herh_interval between 1 and 52),
  herh_dagen      smallint[],
  herh_tot        date,
  uitzonderingen  date[] not null default '{}',      -- geschrapte voorkomens
  ics_uid         text,                              -- herkomst externe agenda
  aangemaakt      timestamptz not null default now(),
  gewijzigd       timestamptz not null default now()
);
create index on gezin.afspraken (huishouden_id, datum);
create index on gezin.afspraken (kalender_id);

-- ---------- Taken met deadline ---------------------------------------
create table gezin.taken (
  id             uuid primary key default gen_random_uuid(),
  huishouden_id  uuid not null references gezin.huishoudens on delete cascade,
  titel          text not null check (length(trim(titel)) between 1 and 200),
  deadline       date not null,
  tijd           time,
  lid_id         uuid references gezin.leden on delete set null,
  notitie        text,
  herh_freq      text check (herh_freq in ('dag', 'week', 'maand', 'jaar')),
  herh_interval  smallint check (herh_interval between 1 and 52),
  herh_dagen     smallint[],
  herh_tot       date,
  uitzonderingen date[] not null default '{}',
  aangemaakt     timestamptz not null default now(),
  gewijzigd      timestamptz not null default now()
);
create index on gezin.taken (huishouden_id, deadline);

-- Afgevinkte voorkomens (per datum, zodat herhalende taken per keer afgevinkt worden)
create table gezin.taak_klaar (
  taak_id       uuid not null references gezin.taken on delete cascade,
  datum         date not null,
  huishouden_id uuid not null references gezin.huishoudens on delete cascade,
  door          uuid default auth.uid(),
  op            timestamptz not null default now(),
  primary key (taak_id, datum)
);

-- ---------- Verjaardagen ---------------------------------------------
create table gezin.verjaardagen (
  id            uuid primary key default gen_random_uuid(),
  huishouden_id uuid not null references gezin.huishoudens on delete cascade,
  naam          text not null check (length(trim(naam)) between 1 and 80),
  datum         date not null,              -- enkel dag en maand tellen; jaar = geboortejaar indien gekend
  geboortejaar  smallint check (geboortejaar between 1900 and 2100),
  lid_id        uuid references gezin.leden on delete set null,
  notitie       text,
  aangemaakt    timestamptz not null default now()
);

-- ---------- Triggers --------------------------------------------------
create trigger afspraken_gewijzigd before update on gezin.afspraken
  for each row execute function gezin.zet_gewijzigd();
create trigger taken_gewijzigd before update on gezin.taken
  for each row execute function gezin.zet_gewijzigd();

-- Eén voorkomen van een reeks schrappen
create function gezin.schrap_voorkomen(p_tabel text, p_id uuid, p_datum date)
returns void
language plpgsql security invoker set search_path = ''
as $$
begin
  if p_tabel = 'afspraken' then
    update gezin.afspraken set uitzonderingen = array_append(uitzonderingen, p_datum) where id = p_id and not (p_datum = any(uitzonderingen));
  elsif p_tabel = 'taken' then
    update gezin.taken set uitzonderingen = array_append(uitzonderingen, p_datum) where id = p_id and not (p_datum = any(uitzonderingen));
  else
    raise exception 'Onbekende tabel';
  end if;
end;
$$;

-- ---------- Row Level Security ---------------------------------------
alter table gezin.kalenders    enable row level security;
alter table gezin.afspraken    enable row level security;
alter table gezin.taken        enable row level security;
alter table gezin.taak_klaar   enable row level security;
alter table gezin.verjaardagen enable row level security;

create policy kalenders_rw on gezin.kalenders for all to authenticated
  using (gezin.is_lid(huishouden_id)) with check (gezin.is_lid(huishouden_id));

create policy afspraken_rw on gezin.afspraken for all to authenticated
  using (gezin.is_lid(huishouden_id))
  with check (gezin.is_lid(huishouden_id)
    and exists (select 1 from gezin.kalenders k where k.id = kalender_id and k.huishouden_id = afspraken.huishouden_id));

create policy taken_rw on gezin.taken for all to authenticated
  using (gezin.is_lid(huishouden_id))
  with check (gezin.is_lid(huishouden_id)
    and (lid_id is null or exists (select 1 from gezin.leden l where l.id = lid_id and l.huishouden_id = taken.huishouden_id)));

create policy taak_klaar_rw on gezin.taak_klaar for all to authenticated
  using (gezin.is_lid(huishouden_id))
  with check (gezin.is_lid(huishouden_id)
    and exists (select 1 from gezin.taken t where t.id = taak_id and t.huishouden_id = taak_klaar.huishouden_id));

create policy verjaardagen_rw on gezin.verjaardagen for all to authenticated
  using (gezin.is_lid(huishouden_id)) with check (gezin.is_lid(huishouden_id));

-- Leden zelf blijven enkel leesbaar; kleur aanpassen mag door gezinsleden
create policy leden_kleur on gezin.leden for update to authenticated
  using (gezin.is_lid(huishouden_id)) with check (gezin.is_lid(huishouden_id));

-- ---------- Rechten ---------------------------------------------------
revoke all on gezin.kalenders, gezin.afspraken, gezin.taken, gezin.taak_klaar, gezin.verjaardagen from public, anon;
grant select, insert, update, delete on
  gezin.kalenders, gezin.afspraken, gezin.taken, gezin.taak_klaar, gezin.verjaardagen to authenticated;
grant update (kleur, naam) on gezin.leden to authenticated;

revoke all on function gezin.voeg_lid_toe(uuid, text, text), gezin.schrap_voorkomen(text, uuid, date), gezin.standaard_kalenders() from public, anon;
grant execute on function gezin.voeg_lid_toe(uuid, text, text), gezin.schrap_voorkomen(text, uuid, date) to authenticated;

-- Bestaande gezinnen (aangemaakt vóór deze migratie) krijgen ook een agenda 'Gezin'
insert into gezin.kalenders (huishouden_id, naam, kleur)
select h.id, 'Gezin', '#2f7a5b' from gezin.huishoudens h
where not exists (select 1 from gezin.kalenders k where k.huishouden_id = h.id);

-- Realtime: partner ziet nieuwe afspraken en afgevinkte taken meteen
alter publication supabase_realtime add table gezin.afspraken, gezin.taken, gezin.taak_klaar;

commit;
