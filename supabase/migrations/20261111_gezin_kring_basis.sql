-- =====================================================================
-- Kring – basismigratie schema "gezin" (Supabase-project Gezinsbudget)
-- Toegepast op 11/11/2026 als migratie "gezin_kring_basis".
-- Inhoud: R1 maaltijden, R2 agenda, R3 lijsten/activiteit/agenda-feed, R4 budget lezen (leest ynab),
--         diepvries, voorraad + kastickets, weekvoorstel, bestellijst (planweek), R5 overleg/kindmodus/Google.
-- Fixes: service_role-rechten voor Edge Function agenda-feed; log_trigger vertakt eerst op tabelnaam.
-- Dit bestand is functioneel gelijk aan de toegepaste migratie (zelfde eindtoestand, andere volgorde).
-- Getest op productie (Postgres 17) met rollback: 32/32.
-- =====================================================================
begin;
-- ===== 20261107_gezin_menu.sql
-- =====================================================================
-- Kring – schema gezin, R1 Maaltijden: gerechten, ingrediënten, weekmenu,
-- boodschappen, Collect&Go-producten en koppeling ingrediënt ↔ product
-- Versie 2 · 8/11/2026 (nog niet uitgevoerd; eerst op een branch testen)
--   v2: maaltijdmomenten ontbijt/middag/snack/avond, omschrijving + fw_id,
--       notitie per ingrediënt, producten, ingredient_product, import-RPC's,
--       realtime op weekmenu en boodschappen
--
-- Additief: maakt enkel schema "gezin" aan. Schema "ynab" en de sync
-- worden niet gelezen, gewijzigd of gerefereerd.
--
-- Vooraf in het Supabase-dashboard (instellingen voor het hele project):
--   1. Authentication > Providers > Email: aan (magic link).
--   2. Authentication > URL Configuration: Site URL + Redirect URL =
--      de GitHub Pages-URL van de app.
--   3. Settings > Data API > Exposed schemas: "gezin" toevoegen
--      (enkel gezin; ynab NIET toevoegen).
-- =====================================================================


create schema if not exists gezin;
revoke all on schema gezin from public, anon;
grant usage on schema gezin to authenticated;

-- ---------- Huishouden en leden --------------------------------------
create table gezin.huishoudens (
  id           uuid primary key default gen_random_uuid(),
  naam         text not null check (length(trim(naam)) between 1 and 80),
  uitnodigcode text not null unique
               default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
  aangemaakt   timestamptz not null default now()
);

create table gezin.leden (
  id            uuid primary key default gen_random_uuid(),
  huishouden_id uuid not null references gezin.huishoudens on delete cascade,
  user_id       uuid references auth.users on delete cascade,  -- null = later: kind zonder account
  naam          text not null check (length(trim(naam)) between 1 and 60),
  rol           text not null default 'lid' check (rol in ('beheerder', 'lid')),
  aangemaakt    timestamptz not null default now(),
  unique (huishouden_id, user_id)
);
create index on gezin.leden (user_id);

-- Hulpfunctie voor RLS: is de aangemelde gebruiker lid van dit huishouden?
create function gezin.is_lid(p_huishouden uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from gezin.leden l
    where l.huishouden_id = p_huishouden
      and l.user_id = (select auth.uid())
  );
$$;

-- ---------- Gerechten en ingrediënten --------------------------------
create table gezin.gerechten (
  id                 uuid primary key default gen_random_uuid(),
  huishouden_id      uuid not null references gezin.huishoudens on delete cascade,
  naam               text not null check (length(trim(naam)) between 1 and 120),
  porties            smallint not null default 4 check (porties between 1 and 40),
  categorie          text,
  bereidingstijd_min smallint check (bereidingstijd_min between 0 and 1440),
  omschrijving       text,
  bereiding          text,
  bron_url           text,
  favoriet           boolean not null default false,
  fw_id              text,          -- herkomst FamilyWall (import is idempotent)
  aangemaakt         timestamptz not null default now(),
  gewijzigd          timestamptz not null default now(),
  unique (huishouden_id, fw_id)
);
create index on gezin.gerechten (huishouden_id, naam);

create table gezin.ingredienten (
  id            uuid primary key default gen_random_uuid(),
  gerecht_id    uuid not null references gezin.gerechten on delete cascade,
  huishouden_id uuid not null references gezin.huishoudens on delete cascade, -- gedenormaliseerd voor RLS
  naam          text not null check (length(trim(naam)) between 1 and 120),
  hoeveelheid   numeric(10,3) check (hoeveelheid is null or hoeveelheid >= 0),
  eenheid       text,          -- g, kg, ml, cl, dl, l, stuk, el, tl, teentje, blik, pak, zakje, blokje, bos, sneetje, stengel, bol, potje, fles
  notitie       text,          -- "fijngesneden", "snuifje" …
  afdeling      text not null default 'Andere',  -- winkelzone
  volgorde      int not null default 0
);
create index on gezin.ingredienten (gerecht_id);

-- ---------- Weekmenu --------------------------------------------------
create table gezin.weekmenu (
  id            uuid primary key default gen_random_uuid(),
  huishouden_id uuid not null references gezin.huishoudens on delete cascade,
  datum         date not null,
  moment        text not null default 'avond' check (moment in ('ontbijt', 'middag', 'snack', 'avond')),
  gerecht_id    uuid references gezin.gerechten on delete set null,
  vrije_tekst   text,          -- "Restjes", "Uit eten" …
  porties       smallint check (porties between 1 and 40),
  gewijzigd     timestamptz not null default now(),
  unique (huishouden_id, datum, moment),
  check (gerecht_id is not null or vrije_tekst is not null)
);

-- ---------- Boodschappen ---------------------------------------------
-- De lijst zelf wordt berekend uit weekmenu × ingrediënten (geen kopie).
-- Hier enkel wat de gebruiker toevoegt of afvinkt, per week (maandag).
create table gezin.boodschappen_extra (
  id            uuid primary key default gen_random_uuid(),
  huishouden_id uuid not null references gezin.huishoudens on delete cascade,
  week_start    date not null check (extract(isodow from week_start) = 1),
  naam          text not null check (length(trim(naam)) between 1 and 120),
  hoeveelheid   numeric(10,3),
  eenheid       text,
  afdeling      text not null default 'Andere',
  afgevinkt     boolean not null default false,
  aangemaakt    timestamptz not null default now()
);
create index on gezin.boodschappen_extra (huishouden_id, week_start);

create table gezin.boodschappen_afgevinkt (
  huishouden_id uuid not null references gezin.huishoudens on delete cascade,
  week_start    date not null,
  sleutel       text not null,  -- "naam in kleine letters|basiseenheid"
  aangemaakt    timestamptz not null default now(),
  primary key (huishouden_id, week_start, sleutel)
);

-- ---------- Producten (Collect&Go) en koppeling ------------------------
create table gezin.producten (
  id             uuid primary key default gen_random_uuid(),
  huishouden_id  uuid not null references gezin.huishoudens on delete cascade,
  cg_product_id  text,                       -- commercieel product-ID van Collect&Go
  naam           text not null,
  afdeling       text not null default 'Andere',
  inhoud         numeric(10,3),              -- verpakking in g, ml of stuk
  inhoud_eenheid text check (inhoud_eenheid in ('g', 'ml', 'stuk')),
  prijs          numeric(8,2),               -- laatst gekende prijs
  prijs_per      text not null default 'stuk' check (prijs_per in ('stuk', 'kg')),
  beschikbaar    boolean not null default true,
  bijgewerkt     timestamptz not null default now(),
  unique (huishouden_id, cg_product_id)
);

-- Eén koppeling per ingrediëntnaam (sleutel), geldt voor alle recepten
create table gezin.ingredient_product (
  huishouden_id uuid not null references gezin.huishoudens on delete cascade,
  sleutel       text not null,               -- genormaliseerde ingrediëntnaam
  product_id    uuid references gezin.producten on delete set null,
  geen_product  boolean not null default false,
  gewijzigd     timestamptz not null default now(),
  primary key (huishouden_id, sleutel)
);

-- ---------- Triggers --------------------------------------------------
create function gezin.zet_gewijzigd()
returns trigger language plpgsql set search_path = ''
as $$ begin new.gewijzigd := now(); return new; end; $$;

create trigger gerechten_gewijzigd before update on gezin.gerechten
  for each row execute function gezin.zet_gewijzigd();
create trigger weekmenu_gewijzigd before update on gezin.weekmenu
  for each row execute function gezin.zet_gewijzigd();

-- Gerecht verwijderen: geplande dagen houden de naam als vrije tekst
create function gezin.bewaar_naam_bij_verwijderen()
returns trigger language plpgsql set search_path = ''
as $$
begin
  update gezin.weekmenu
     set vrije_tekst = coalesce(vrije_tekst, old.naam)
   where gerecht_id = old.id;
  return old;
end;
$$;
create trigger gerechten_verwijderen before delete on gezin.gerechten
  for each row execute function gezin.bewaar_naam_bij_verwijderen();

-- ---------- Row Level Security ---------------------------------------
alter table gezin.huishoudens            enable row level security;
alter table gezin.leden                  enable row level security;
alter table gezin.gerechten              enable row level security;
alter table gezin.ingredienten           enable row level security;
alter table gezin.weekmenu               enable row level security;
alter table gezin.boodschappen_extra     enable row level security;
alter table gezin.boodschappen_afgevinkt enable row level security;
alter table gezin.producten              enable row level security;
alter table gezin.ingredient_product     enable row level security;

create policy producten_rw on gezin.producten
  for all to authenticated
  using (gezin.is_lid(huishouden_id))
  with check (gezin.is_lid(huishouden_id));

create policy koppeling_rw on gezin.ingredient_product
  for all to authenticated
  using (gezin.is_lid(huishouden_id))
  with check (
    gezin.is_lid(huishouden_id)
    and (product_id is null
         or exists (select 1 from gezin.producten p
                    where p.id = product_id and p.huishouden_id = ingredient_product.huishouden_id))
  );

create policy huishoudens_lezen on gezin.huishoudens
  for select to authenticated using (gezin.is_lid(id));

create policy leden_lezen on gezin.leden
  for select to authenticated using (gezin.is_lid(huishouden_id));

create policy gerechten_rw on gezin.gerechten
  for all to authenticated
  using (gezin.is_lid(huishouden_id))
  with check (gezin.is_lid(huishouden_id));

create policy ingredienten_rw on gezin.ingredienten
  for all to authenticated
  using (gezin.is_lid(huishouden_id))
  with check (
    gezin.is_lid(huishouden_id)
    and exists (select 1 from gezin.gerechten g
                where g.id = gerecht_id and g.huishouden_id = ingredienten.huishouden_id)
  );

create policy weekmenu_rw on gezin.weekmenu
  for all to authenticated
  using (gezin.is_lid(huishouden_id))
  with check (
    gezin.is_lid(huishouden_id)
    and (gerecht_id is null
         or exists (select 1 from gezin.gerechten g
                    where g.id = gerecht_id and g.huishouden_id = weekmenu.huishouden_id))
  );

create policy extra_rw on gezin.boodschappen_extra
  for all to authenticated
  using (gezin.is_lid(huishouden_id))
  with check (gezin.is_lid(huishouden_id));

create policy afgevinkt_rw on gezin.boodschappen_afgevinkt
  for all to authenticated
  using (gezin.is_lid(huishouden_id))
  with check (gezin.is_lid(huishouden_id));

-- ---------- Functies --------------------------------------------------
-- Nieuw huishouden; de aanmaker wordt beheerder. Voorlopig 1 huishouden per gebruiker.
create function gezin.maak_huishouden(p_naam text, p_weergavenaam text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_h uuid;
begin
  if (select auth.uid()) is null then raise exception 'Niet aangemeld'; end if;
  if exists (select 1 from gezin.leden where user_id = (select auth.uid())) then
    raise exception 'Je bent al lid van een gezin';
  end if;
  insert into gezin.huishoudens (naam) values (trim(p_naam)) returning id into v_h;
  insert into gezin.leden (huishouden_id, user_id, naam, rol)
  values (v_h, (select auth.uid()), trim(p_weergavenaam), 'beheerder');
  return v_h;
end;
$$;

-- Aansluiten bij een bestaand huishouden met de uitnodigcode
create function gezin.aansluiten(p_code text, p_weergavenaam text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_h uuid;
begin
  if (select auth.uid()) is null then raise exception 'Niet aangemeld'; end if;
  select id into v_h from gezin.huishoudens
   where uitnodigcode = upper(trim(p_code));
  if v_h is null then raise exception 'Onbekende uitnodigcode'; end if;
  if exists (select 1 from gezin.leden
             where user_id = (select auth.uid()) and huishouden_id <> v_h) then
    raise exception 'Je bent al lid van een ander gezin';
  end if;
  insert into gezin.leden (huishouden_id, user_id, naam)
  values (v_h, (select auth.uid()), trim(p_weergavenaam))
  on conflict (huishouden_id, user_id) do nothing;
  return v_h;
end;
$$;

-- Gerecht + ingrediënten in één transactie bewaren.
-- security invoker: RLS blijft gelden.
create function gezin.bewaar_gerecht(p jsonb)
returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_h  uuid := nullif(p->>'huishouden_id', '')::uuid;
begin
  if v_id is null then
    insert into gezin.gerechten (huishouden_id, naam, porties, categorie, bereidingstijd_min,
                                 omschrijving, bereiding, bron_url, favoriet, fw_id)
    values (v_h, trim(p->>'naam'),
            coalesce(nullif(p->>'porties', '')::numeric::smallint, 4),
            nullif(p->>'categorie', ''),
            nullif(p->>'bereidingstijd_min', '')::numeric::smallint,
            nullif(p->>'omschrijving', ''),
            nullif(p->>'bereiding', ''),
            nullif(p->>'bron_url', ''),
            coalesce((p->>'favoriet')::boolean, false),
            nullif(p->>'fw_id', ''))
    returning id into v_id;
  else
    update gezin.gerechten set
      naam               = trim(p->>'naam'),
      porties            = coalesce(nullif(p->>'porties', '')::numeric::smallint, 4),
      categorie          = nullif(p->>'categorie', ''),
      bereidingstijd_min = nullif(p->>'bereidingstijd_min', '')::numeric::smallint,
      omschrijving       = nullif(p->>'omschrijving', ''),
      bereiding          = nullif(p->>'bereiding', ''),
      bron_url           = nullif(p->>'bron_url', ''),
      favoriet           = coalesce((p->>'favoriet')::boolean, false)
    where id = v_id
    returning huishouden_id into v_h;
    if not found then raise exception 'Gerecht niet gevonden'; end if;
    delete from gezin.ingredienten where gerecht_id = v_id;
  end if;

  insert into gezin.ingredienten (gerecht_id, huishouden_id, naam, hoeveelheid,
                                  eenheid, notitie, afdeling, volgorde)
  select v_id, v_h, trim(i->>'naam'),
         nullif(i->>'hoeveelheid', '')::numeric,
         nullif(i->>'eenheid', ''),
         nullif(i->>'notitie', ''),
         coalesce(nullif(i->>'afdeling', ''), 'Andere'),
         t.n::int
  from jsonb_array_elements(coalesce(p->'ingredienten', '[]'::jsonb)) with ordinality as t(i, n)
  where trim(coalesce(i->>'naam', '')) <> '';

  return v_id;
end;
$$;

-- Eenmalige import van de FamilyWall-recepten (data/seed_recepten.json).
-- Idempotent op fw_id: opnieuw uitvoeren voegt geen dubbels toe. Geeft het aantal nieuwe recepten.
create function gezin.importeer_recepten(p_huishouden uuid, p jsonb)
returns int
language plpgsql security invoker set search_path = ''
as $$
declare r jsonb; n int := 0;
begin
  if not gezin.is_lid(p_huishouden) then raise exception 'Geen toegang tot dit gezin'; end if;
  for r in select * from jsonb_array_elements(p) loop
    if not exists (select 1 from gezin.gerechten
                   where huishouden_id = p_huishouden and fw_id = r->>'fw_id') then
      perform gezin.bewaar_gerecht((r - 'id') || jsonb_build_object('huishouden_id', p_huishouden));
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

-- Producten (data/seed_producten.json) toevoegen of bijwerken op cg_product_id
create function gezin.importeer_producten(p_huishouden uuid, p jsonb)
returns int
language plpgsql security invoker set search_path = ''
as $$
declare n int;
begin
  if not gezin.is_lid(p_huishouden) then raise exception 'Geen toegang tot dit gezin'; end if;
  insert into gezin.producten (huishouden_id, cg_product_id, naam, afdeling, inhoud,
                               inhoud_eenheid, prijs, prijs_per, beschikbaar)
  select p_huishouden, x->>'cg_product_id', x->>'naam', coalesce(x->>'afdeling', 'Andere'),
         nullif(x->>'inhoud', '')::numeric, nullif(x->>'inhoud_eenheid', ''),
         nullif(x->>'prijs', '')::numeric, coalesce(x->>'prijs_per', 'stuk'),
         coalesce((x->>'beschikbaar')::boolean, true)
  from jsonb_array_elements(p) x
  on conflict (huishouden_id, cg_product_id) do update set
    naam = excluded.naam, afdeling = excluded.afdeling, inhoud = excluded.inhoud,
    inhoud_eenheid = excluded.inhoud_eenheid, prijs = excluded.prijs,
    prijs_per = excluded.prijs_per, beschikbaar = excluded.beschikbaar, bijgewerkt = now();
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------- Rechten ---------------------------------------------------
revoke all on all tables    in schema gezin from public, anon;
revoke all on all functions in schema gezin from public, anon;

grant select on gezin.huishoudens, gezin.leden to authenticated;
grant select, insert, update, delete on
  gezin.gerechten, gezin.ingredienten, gezin.weekmenu,
  gezin.boodschappen_extra, gezin.boodschappen_afgevinkt,
  gezin.producten, gezin.ingredient_product
  to authenticated;

grant execute on function
  gezin.is_lid(uuid),
  gezin.maak_huishouden(text, text),
  gezin.aansluiten(text, text),
  gezin.bewaar_gerecht(jsonb),
  gezin.importeer_recepten(uuid, jsonb),
  gezin.importeer_producten(uuid, jsonb)
  to authenticated;

-- ---------- Realtime (partner ziet planning en afvinken meteen) --------
-- Realtime respecteert RLS: elk gezin krijgt enkel zijn eigen wijzigingen.
alter publication supabase_realtime add table
  gezin.weekmenu, gezin.boodschappen_extra, gezin.boodschappen_afgevinkt;


-- ---------- Controle na uitvoeren (read-only) -------------------------
-- select table_name from information_schema.tables where table_schema = 'gezin';
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_schema = 'gezin' and grantee in ('anon', 'public');   -- verwacht: 0 rijen
-- select count(*) from ynab.<een tabel>;                              -- ongewijzigd
-- ===== 20261108_gezin_agenda.sql
-- =====================================================================
-- Kring – schema gezin, R2 Agenda: agenda's, afspraken, taken met deadline,
-- verjaardagen, gezinsleden zonder account, externe agenda's (ICS)
-- Versie 1 · 8/11/2026 (nog niet uitgevoerd; na 20261107_gezin_menu.sql, eerst op een branch)
--
-- Additief: enkel schema "gezin". Raakt "ynab" niet.
-- Feestdagen en schoolvakanties worden in de app berekend (geen tabel nodig).
-- =====================================================================


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

-- ===== 20261108_gezin_lijsten.sql
-- =====================================================================
-- Kring – schema gezin, R3 Gezin: lijsten (to-do en vrije lijsten), activiteit,
-- agenda-feed voor Google Agenda
-- Versie 1 · 8/11/2026 (nog niet uitgevoerd; na 20261108_gezin_agenda.sql, eerst op een branch)
-- Additief: enkel schema "gezin".
-- =====================================================================


-- Het lid dat bij de aangemelde gebruiker hoort
create function gezin.mijn_lid(p_huishouden uuid)
returns uuid language sql stable security definer set search_path = ''
as $$ select id from gezin.leden where huishouden_id = p_huishouden and user_id = (select auth.uid()) limit 1 $$;

-- ---------- Lijsten ---------------------------------------------------
create table gezin.lijsten (
  id            uuid primary key default gen_random_uuid(),
  huishouden_id uuid not null references gezin.huishoudens on delete cascade,
  naam          text not null check (length(trim(naam)) between 1 and 80),
  soort         text not null default 'lijst' check (soort in ('todo', 'lijst', 'boodschap')),
  prive         boolean not null default false,
  vast          boolean not null default false,
  eigenaar_lid  uuid references gezin.leden on delete set null,
  aangemaakt    timestamptz not null default now()
);

create table gezin.lijst_items (
  id            uuid primary key default gen_random_uuid(),
  lijst_id      uuid not null references gezin.lijsten on delete cascade,
  huishouden_id uuid not null references gezin.huishoudens on delete cascade,
  tekst         text not null check (length(trim(tekst)) between 1 and 300),
  klaar         boolean not null default false,
  lid_id        uuid references gezin.leden on delete set null,
  deadline      date,
  volgorde      int not null default 0,
  aangemaakt    timestamptz not null default now(),
  gewijzigd     timestamptz not null default now()
);
create index on gezin.lijst_items (lijst_id);
create trigger lijst_items_gewijzigd before update on gezin.lijst_items
  for each row execute function gezin.zet_gewijzigd();

-- Privélijst: enkel zichtbaar voor de eigenaar
create function gezin.mag_lijst(p_lijst uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from gezin.lijsten l
                 where l.id = p_lijst and gezin.is_lid(l.huishouden_id)
                   and (not l.prive or l.eigenaar_lid = gezin.mijn_lid(l.huishouden_id)));
$$;

-- ---------- Activiteit (wie deed wat) --------------------------------
create table gezin.activiteit (
  id            bigint generated always as identity primary key,
  huishouden_id uuid not null references gezin.huishoudens on delete cascade,
  wie           text not null,
  wat           text not null,
  op            timestamptz not null default now()
);
create index on gezin.activiteit (huishouden_id, op desc);

create function gezin.log(p_huishouden uuid, p_wat text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  insert into gezin.activiteit (huishouden_id, wie, wat)
  values (p_huishouden, coalesce((select naam from gezin.leden where id = gezin.mijn_lid(p_huishouden)), 'Iemand'), left(p_wat, 300));
end;
$$;

-- Triggers: de belangrijkste gebeurtenissen automatisch loggen (privélijsten niet)
create function gezin.log_trigger()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_lijst gezin.lijsten;
begin
  if tg_table_name = 'lijst_items' then
    select * into v_lijst from gezin.lijsten where id = new.lijst_id;
    if v_lijst.prive then return new; end if;
    if tg_op = 'INSERT' then perform gezin.log(new.huishouden_id, format('zette ''%s'' op %s', new.tekst, v_lijst.naam));
    elsif new.klaar and not old.klaar then perform gezin.log(new.huishouden_id, format('vinkte ''%s'' af op %s', new.tekst, v_lijst.naam)); end if;
  elsif tg_table_name = 'taak_klaar' then
    perform gezin.log(new.huishouden_id, format('vinkte ''%s'' af', (select titel from gezin.taken where id = new.taak_id)));
  elsif tg_table_name = 'afspraken' and tg_op = 'INSERT' and new.ics_uid is null then
    perform gezin.log(new.huishouden_id, format('plande ''%s''', new.titel));
  elsif tg_table_name = 'weekmenu' and new.gerecht_id is not null then
    perform gezin.log(new.huishouden_id, format('zette ''%s'' op het menu', (select naam from gezin.gerechten where id = new.gerecht_id)));
  end if;
  return new;
end;
$$;
create trigger log_lijst_items after insert or update of klaar on gezin.lijst_items for each row execute function gezin.log_trigger();
create trigger log_taak_klaar  after insert on gezin.taak_klaar for each row execute function gezin.log_trigger();
create trigger log_afspraken   after insert on gezin.afspraken for each row execute function gezin.log_trigger();
create trigger log_weekmenu    after insert or update of gerecht_id on gezin.weekmenu for each row execute function gezin.log_trigger();

-- ---------- Agenda-feed (Kring → Google Agenda, abonneren via geheime link) -----
create table gezin.agenda_feed (
  huishouden_id uuid primary key references gezin.huishoudens on delete cascade,
  token         text not null unique default replace(gen_random_uuid()::text, '-', '') || left(replace(gen_random_uuid()::text, '-', ''), 16),  -- 48 hex
  aangemaakt    timestamptz not null default now()
);

-- ---------- Row Level Security ---------------------------------------
alter table gezin.lijsten     enable row level security;
alter table gezin.lijst_items enable row level security;
alter table gezin.activiteit  enable row level security;
alter table gezin.agenda_feed enable row level security;

create policy lijsten_lezen on gezin.lijsten for select to authenticated
  using (gezin.is_lid(huishouden_id) and (not prive or eigenaar_lid = gezin.mijn_lid(huishouden_id)));
create policy lijsten_schrijven on gezin.lijsten for insert to authenticated
  with check (gezin.is_lid(huishouden_id));
create policy lijsten_wijzigen on gezin.lijsten for update to authenticated
  using (gezin.mag_lijst(id)) with check (gezin.is_lid(huishouden_id));
create policy lijsten_wissen on gezin.lijsten for delete to authenticated
  using (gezin.mag_lijst(id));

create policy items_rw on gezin.lijst_items for all to authenticated
  using (gezin.mag_lijst(lijst_id))
  with check (gezin.mag_lijst(lijst_id)
    and exists (select 1 from gezin.lijsten l where l.id = lijst_id and l.huishouden_id = lijst_items.huishouden_id));

create policy activiteit_lezen on gezin.activiteit for select to authenticated using (gezin.is_lid(huishouden_id));
create policy feed_lezen on gezin.agenda_feed for select to authenticated using (gezin.is_lid(huishouden_id));

-- ---------- Rechten ---------------------------------------------------
revoke all on gezin.lijsten, gezin.lijst_items, gezin.activiteit, gezin.agenda_feed from public, anon;
grant select, insert, update, delete on gezin.lijsten, gezin.lijst_items to authenticated;
grant select on gezin.activiteit, gezin.agenda_feed to authenticated;
revoke all on function gezin.mijn_lid(uuid), gezin.mag_lijst(uuid), gezin.log(uuid, text), gezin.log_trigger() from public, anon;
grant execute on function gezin.mijn_lid(uuid), gezin.mag_lijst(uuid) to authenticated;

-- Feed-link aanmaken (één per gezin)
create function gezin.agenda_feed_link(p_huishouden uuid)
returns text language plpgsql security definer set search_path = ''
as $$
declare v text;
begin
  if not gezin.is_lid(p_huishouden) then raise exception 'Geen toegang tot dit gezin'; end if;
  insert into gezin.agenda_feed (huishouden_id) values (p_huishouden) on conflict (huishouden_id) do nothing;
  select token into v from gezin.agenda_feed where huishouden_id = p_huishouden;
  return v;
end;
$$;
revoke all on function gezin.agenda_feed_link(uuid) from public, anon;
grant execute on function gezin.agenda_feed_link(uuid) to authenticated;

alter publication supabase_realtime add table gezin.lijst_items, gezin.activiteit;

-- ===== 20261108_gezin_budget_lezen.sql
-- =====================================================================
-- Kring – R4 Budget lezen: gegevens uit de YNAB-spiegel (schema ynab) voor de rekenmotor in de app
-- Versie 1 · 8/11/2026 (nog niet uitgevoerd; eerst op een branch)
--
-- Leest enkel uit schema ynab (geen wijzigingen, geen afhankelijkheid van ynab-views).
-- Enkel het plan dat aan het gezin gekoppeld is (gezamenlijk plan); persoonlijke plannen blijven onzichtbaar.
-- De rekenregels zijn gevalideerd op de spiegel (8/11/2026): activiteit en beschikbaar 14.873/14.873,
-- te verdelen 106/107 maanden (afwijking in de kredietkaartlogica, nog uit te zoeken).
-- =====================================================================


-- Welk YNAB-plan hoort bij welk gezin (eenmalig invullen door de beheerder)
create table gezin.budget_bron (
  huishouden_id uuid primary key references gezin.huishoudens on delete cascade,
  plan_id       uuid not null,               -- ynab.plan.plan_id van het gezamenlijke plan
  maanden_terug int not null default 24 check (maanden_terug between 3 and 240)
);
alter table gezin.budget_bron enable row level security;
create policy budget_bron_lezen on gezin.budget_bron for select to authenticated using (gezin.is_lid(huishouden_id));
revoke all on gezin.budget_bron from public, anon;
grant select on gezin.budget_bron to authenticated;

create function gezin.budget_gegevens(p_huishouden uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_plan uuid; v_terug int; v_start date; v_res jsonb;
begin
  if not gezin.is_lid(p_huishouden) then raise exception 'Geen toegang tot dit gezin'; end if;
  select plan_id, maanden_terug into v_plan, v_terug from gezin.budget_bron where huishouden_id = p_huishouden;
  if v_plan is null then return null; end if;
  v_start := (date_trunc('month', current_date) - make_interval(months => v_terug))::date;   -- laatste maand vóór het venster

  with
  cat as (
    select c.category_id, c.category_group_id, c.name, c.hidden, c.goal_type, c.goal_target,
           g.name = 'Credit Card Payments' as kk,
           (c.internal or g.internal) and g.name <> 'Credit Card Payments' as intern,
           c.name like 'Inflow:%' as inflow
    from ynab.category c join ynab.category_group g using (category_group_id)
    where c.plan_id = v_plan and not c.deleted and not g.deleted),
  mc as (select m.*, cat.kk, cat.intern, cat.inflow from ynab.month_category m join cat using (category_id) where m.plan_id = v_plan),
  per as (select month, sum(activity) filter (where inflow) inkomen, sum(budgeted) filter (where not intern) toegewezen,
                 sum(least(balance, 0)) filter (where not intern and not kk) overbesteed
          from mc where month <= v_start group by month),
  a_start as (select coalesce(sum(inkomen), 0) - coalesce(sum(toegewezen), 0)
                     + coalesce(sum(overbesteed) filter (where month < v_start), 0) as a from per),
  tx as (
    select t.transaction_id, t.date, t.amount, t.memo, t.cleared, t.account_id, t.transfer_account_id, t.category_id, t.is_split, p.name as payee
    from ynab.txn t left join ynab.payee p on p.payee_id = t.payee_id and p.plan_id = t.plan_id
    where t.plan_id = v_plan and not t.deleted and t.date > (v_start + interval '1 month' - interval '1 day')::date),
  begin_saldo as (
    select t.account_id, sum(t.amount) s from ynab.txn t
    where t.plan_id = v_plan and not t.deleted and t.date <= (v_start + interval '1 month' - interval '1 day')::date group by 1)
  select jsonb_build_object(
    'huidig', to_char(current_date, 'YYYY-MM'),
    'bron', 'ynab',
    'groepen', (select jsonb_agg(jsonb_build_object('id', g.category_group_id, 'naam', g.name) order by g.name = 'Credit Card Payments', g.name)
                from ynab.category_group g where g.plan_id = v_plan and not g.deleted and (not g.internal or g.name = 'Credit Card Payments')
                  and exists (select 1 from cat where cat.category_group_id = g.category_group_id and not cat.intern)),
    'categorieen', (select jsonb_agg(jsonb_build_object(
        'id', c.category_id, 'groep_id', c.category_group_id, 'naam', c.name, 'verborgen', c.hidden,
        'target', case when c.goal_type in ('MF', 'NEED') and c.goal_target > 0 then jsonb_build_object('type', 'maand', 'bedrag', round(c.goal_target * 100))
                       when c.goal_type in ('TB', 'TBD') and c.goal_target > 0 then jsonb_build_object('type', 'buffer', 'bedrag', round(c.goal_target * 100)) end,
        'activiteit_per_maand', case when c.kk then (select jsonb_object_agg(to_char(m.month, 'YYYY-MM'), round(m.activity * 100)) from mc m where m.category_id = c.category_id and m.month > v_start) end))
      from cat c where not c.intern and not c.inflow),
    'rekeningen', (select jsonb_agg(jsonb_build_object('id', a.account_id, 'naam', a.name,
        'type', case a.type when 'checking' then 'zicht' when 'savings' then 'spaar' when 'cash' then 'cash' when 'creditCard' then 'krediet' else 'tracking' end,
        'op_budget', a.on_budget, 'gesloten', a.closed) order by a.on_budget desc, a.closed, a.name)
      from ynab.account a where a.plan_id = v_plan and not a.deleted),
    'transacties', coalesce((select jsonb_agg(x order by x->>'datum') from (
        select jsonb_build_object('id', 'b-' || b.account_id, 'rekening_id', b.account_id, 'datum', to_char(v_start + interval '1 month', 'YYYY-MM-DD'),
                                  'bedrag', round(b.s * 100), 'begunstigde', 'Saldo vóór ' || to_char(v_start + interval '1 month', 'MM/YYYY'), 'categorie_id', null, 'status', 'r') x
        from begin_saldo b
        union all
        select jsonb_build_object('id', t.transaction_id, 'rekening_id', t.account_id, 'datum', t.date, 'bedrag', round(t.amount * 100),
          'begunstigde', coalesce(t.payee, ''), 'memo', coalesce(t.memo, ''),
          'categorie_id', case when (select inflow from cat where cat.category_id = t.category_id) then 'RTA' else t.category_id::text end,
          'transfer_rekening_id', t.transfer_account_id,
          'status', case t.cleared when 'reconciled' then 'r' when 'cleared' then 'c' else 'u' end,
          'splits', case when t.is_split then (select jsonb_agg(jsonb_build_object('categorie_id',
                         case when (select inflow from cat where cat.category_id = s.category_id) then 'RTA' else s.category_id::text end,
                         'bedrag', round(s.amount * 100), 'memo', coalesce(s.memo, '')))
                       from ynab.subtxn s where s.plan_id = v_plan and s.transaction_id = t.transaction_id and not s.deleted) end)
        from tx t) q(x)), '[]'::jsonb),
    'toewijzingen', coalesce((select jsonb_object_agg(m, b) from (
        select to_char(month, 'YYYY-MM') m, jsonb_object_agg(category_id, round(budgeted * 100)) b
        from mc where month > v_start and budgeted <> 0 and not intern group by month) q), '{}'::jsonb),
    'start', jsonb_build_object('maand', to_char(v_start, 'YYYY-MM'), 'A', (select round(a * 100) from a_start),
        'beschikbaar', coalesce((select jsonb_object_agg(category_id, round(balance * 100)) from mc where month = v_start and not intern and not inflow), '{}'::jsonb)),
    'controle', jsonb_build_object(
        'beschikbaar', (select jsonb_object_agg(m, b) from (select to_char(month, 'YYYY-MM') m, jsonb_object_agg(category_id, round(balance * 100)) b
                        from mc where month > v_start and not intern and not inflow group by month) q),
        'te_verdelen', (select jsonb_object_agg(to_char(month, 'YYYY-MM'), round(to_be_budgeted * 100)) from ynab.month_summary where plan_id = v_plan and month > v_start))
  ) into v_res;
  return v_res;
end;
$$;

revoke all on function gezin.budget_gegevens(uuid) from public, anon;
grant execute on function gezin.budget_gegevens(uuid) to authenticated;


-- Na uitvoeren, eenmalig (beheerder, SQL Editor):
-- insert into gezin.budget_bron (huishouden_id, plan_id)
-- select h.id, p.plan_id from gezin.huishoudens h, ynab.plan p where h.naam = '<naam gezin>' and p.name = 'Gezamelijke';
-- ===== 20261109_gezin_diepvries.sql

create table gezin.diepvries_plaatsen (
  id            uuid primary key default gen_random_uuid(),
  huishouden_id uuid not null references gezin.huishoudens on delete cascade,
  code          text not null check (length(trim(code)) between 1 and 6),
  naam          text not null check (length(trim(naam)) between 1 and 60),
  soort         text not null default 'bak' check (soort in ('schap', 'bak', 'deur', 'andere')),
  volgorde      int  not null default 0,
  actief        boolean not null default true,
  aangemaakt    timestamptz not null default now(),
  unique (huishouden_id, code)
);

create table gezin.diepvries_categorieen (
  id             uuid primary key default gen_random_uuid(),
  huishouden_id  uuid not null references gezin.huishoudens on delete cascade,
  naam           text not null check (length(trim(naam)) between 1 and 60),
  plaats_id      uuid references gezin.diepvries_plaatsen on delete set null,
  bewaar_maanden smallint not null default 3 check (bewaar_maanden between 1 and 36),
  volgorde       int not null default 0,
  unique (huishouden_id, naam)
);

create table gezin.diepvries_dozen (
  id            uuid primary key default gen_random_uuid(),
  huishouden_id uuid not null references gezin.huishoudens on delete cascade,
  nummer        int  not null check (nummer between 1 and 9999),
  label         text generated always as ('D' || lpad(nummer::text, 3, '0')) stored,
  inhoud_ml     int  check (inhoud_ml between 50 and 10000),
  vorm          text,
  actief        boolean not null default true,
  notitie       text,
  aangemaakt    timestamptz not null default now(),
  unique (huishouden_id, nummer)
);

create table gezin.diepvries_items (
  id             uuid primary key default gen_random_uuid(),
  huishouden_id  uuid not null references gezin.huishoudens on delete cascade,
  soort          text not null default 'gerecht' check (soort in ('gerecht', 'product', 'vrij')),
  gerecht_id     uuid references gezin.gerechten on delete set null,
  product_id     uuid references gezin.producten on delete set null,
  naam           text not null check (length(trim(naam)) between 1 and 120),
  categorie_id   uuid references gezin.diepvries_categorieen on delete set null,
  plaats_id      uuid references gezin.diepvries_plaatsen on delete set null,
  doos_id        uuid references gezin.diepvries_dozen on delete restrict,
  aantal         numeric(8,2) not null default 1 check (aantal > 0),
  eenheid        text not null default 'portie'
                 check (eenheid in ('portie', 'stuk', 'zak', 'doos', 'pak', 'g', 'ml')),
  ingevroren_op  date not null default current_date,
  eet_voor       date,
  notitie        text,
  uit_op         timestamptz,
  uit_door       uuid,
  aangemaakt     timestamptz not null default now(),
  gewijzigd      timestamptz not null default now(),
  check (eet_voor is null or eet_voor >= ingevroren_op)
);
create index on gezin.diepvries_items (huishouden_id) where uit_op is null;
create index on gezin.diepvries_items (plaats_id) where uit_op is null;
create unique index diepvries_doos_bezet on gezin.diepvries_items (doos_id)
  where uit_op is null and doos_id is not null;

create function gezin.diepvries_aanvullen()
returns trigger language plpgsql set search_path = ''
as $$
declare v_cat gezin.diepvries_categorieen;
begin
  if new.naam is null or trim(new.naam) = '' then
    new.naam := coalesce(
      (select naam from gezin.gerechten where id = new.gerecht_id),
      (select naam from gezin.producten where id = new.product_id));
  end if;
  if new.categorie_id is not null then
    select * into v_cat from gezin.diepvries_categorieen where id = new.categorie_id;
    if new.plaats_id is null then new.plaats_id := v_cat.plaats_id; end if;
    if tg_op = 'INSERT' and new.eet_voor is null then
      new.eet_voor := (new.ingevroren_op + make_interval(months => coalesce(v_cat.bewaar_maanden, 3)))::date;
    end if;
  end if;
  return new;
end;
$$;
create trigger diepvries_items_aanvullen before insert or update of categorie_id on gezin.diepvries_items
  for each row execute function gezin.diepvries_aanvullen();
create trigger diepvries_items_gewijzigd before update on gezin.diepvries_items
  for each row execute function gezin.zet_gewijzigd();

create function gezin.diepvries_standaard(p_huishouden uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from gezin.diepvries_plaatsen where huishouden_id = p_huishouden) then return; end if;
  insert into gezin.diepvries_plaatsen (huishouden_id, code, naam, soort, volgorde) values
    (p_huishouden, 'S1', 'Schap boven', 'schap', 1),
    (p_huishouden, 'S2', 'Schap onder', 'schap', 2),
    (p_huishouden, 'B1', 'Bak 1', 'bak', 3),
    (p_huishouden, 'B2', 'Bak 2', 'bak', 4),
    (p_huishouden, 'B3', 'Bak 3', 'bak', 5),
    (p_huishouden, 'B4', 'Bak 4', 'bak', 6),
    (p_huishouden, 'B5', 'Bak 5', 'bak', 7);
  insert into gezin.diepvries_categorieen (huishouden_id, naam, plaats_id, bewaar_maanden, volgorde)
  select p_huishouden, c.naam, p.id, c.maanden, c.volg
  from (values ('Bereide gerechten', 'B1', 3, 1), ('Soep en saus', 'B1', 3, 2),
               ('Vlees', 'B2', 6, 3), ('Vis', 'B2', 4, 4),
               ('Groenten', 'B3', 8, 5), ('Fruit', 'B3', 8, 6),
               ('Brood en deeg', 'B4', 3, 7), ('IJs en dessert', 'B5', 2, 8),
               ('Kruiden', 'S1', 6, 9), ('Andere', 'S2', 3, 10)) c(naam, code, maanden, volg)
  join gezin.diepvries_plaatsen p on p.huishouden_id = p_huishouden and p.code = c.code;
end;
$$;

create function gezin.diepvries_standaard_trigger()
returns trigger language plpgsql security definer set search_path = ''
as $$ begin perform gezin.diepvries_standaard(new.id); return new; end; $$;
create trigger huishouden_diepvries after insert on gezin.huishoudens
  for each row execute function gezin.diepvries_standaard_trigger();

create function gezin.diepvries_log()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_waar text;
begin
  select concat_ws(', ', (select label from gezin.diepvries_dozen where id = new.doos_id),
                         (select code  from gezin.diepvries_plaatsen where id = new.plaats_id))
    into v_waar;
  if tg_op = 'INSERT' then
    perform gezin.log(new.huishouden_id, format('vroor ''%s'' in%s', new.naam,
                      case when v_waar <> '' then ' (' || v_waar || ')' else '' end));
  elsif new.uit_op is not null and old.uit_op is null then
    perform gezin.log(new.huishouden_id, format('haalde ''%s'' uit de diepvries', new.naam));
  end if;
  return new;
end;
$$;
create trigger log_diepvries after insert or update of uit_op on gezin.diepvries_items
  for each row execute function gezin.diepvries_log();

create function gezin.diepvries_dozen_toevoegen(p_huishouden uuid, p_aantal int,
                                                p_inhoud_ml int default null, p_vorm text default null)
returns text[]
language plpgsql security invoker set search_path = ''
as $$
declare v_start int; v_labels text[];
begin
  if not gezin.is_lid(p_huishouden) then raise exception 'Geen toegang tot dit gezin'; end if;
  if p_aantal not between 1 and 200 then raise exception 'Aantal tussen 1 en 200'; end if;
  perform pg_advisory_xact_lock(hashtext('diepvries_dozen' || p_huishouden::text));
  select coalesce(max(nummer), 0) + 1 into v_start from gezin.diepvries_dozen where huishouden_id = p_huishouden;
  with nieuw as (
    insert into gezin.diepvries_dozen (huishouden_id, nummer, inhoud_ml, vorm)
    select p_huishouden, n, p_inhoud_ml, nullif(trim(p_vorm), '')
    from generate_series(v_start, v_start + p_aantal - 1) n
    returning label)
  select array_agg(label order by label) into v_labels from nieuw;
  return v_labels;
end;
$$;

create function gezin.diepvries_uit(p_item uuid, p_aantal numeric default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v gezin.diepvries_items;
begin
  select * into v from gezin.diepvries_items where id = p_item for update;
  if not found or not gezin.is_lid(v.huishouden_id) then raise exception 'Niet gevonden'; end if;
  if v.uit_op is not null then return jsonb_build_object('fout', 'Al uitgehaald'); end if;
  if p_aantal is not null and p_aantal <= 0 then raise exception 'Aantal moet positief zijn'; end if;
  if p_aantal is null or p_aantal >= v.aantal then
    update gezin.diepvries_items set uit_op = now(), uit_door = (select auth.uid()) where id = p_item;
    return jsonb_build_object('ok', true, 'rest', 0, 'doos_vrij', v.doos_id is not null);
  end if;
  update gezin.diepvries_items set aantal = aantal - p_aantal where id = p_item;
  perform gezin.log(v.huishouden_id, format('haalde %s %s ''%s'' uit de diepvries',
                    trim(to_char(p_aantal, 'FM9999990.##')), v.eenheid, v.naam));
  return jsonb_build_object('ok', true, 'rest', v.aantal - p_aantal, 'doos_vrij', false);
end;
$$;

create function gezin.diepvries_doos(p_huishouden uuid, p_label text)
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select jsonb_build_object(
    'doos', jsonb_build_object('id', d.id, 'label', d.label, 'inhoud_ml', d.inhoud_ml, 'vorm', d.vorm, 'actief', d.actief),
    'inhoud', (select to_jsonb(i) - 'huishouden_id' from gezin.diepvries_items i
               where i.doos_id = d.id and i.uit_op is null))
  from gezin.diepvries_dozen d
  where d.huishouden_id = p_huishouden and d.label = upper(trim(p_label));
$$;

create view gezin.v_diepvries with (security_invoker = true) as
select i.id, i.huishouden_id, i.soort, i.naam, i.aantal, i.eenheid, i.notitie,
       i.ingevroren_op, i.eet_voor,
       (i.eet_voor < current_date) as te_oud,
       (extract(year from age(current_date, i.ingevroren_op)) * 12
        + extract(month from age(current_date, i.ingevroren_op)))::int as maanden_oud,
       d.label as doos, p.code as plaats_code, p.naam as plaats_naam,
       c.naam as categorie, i.gerecht_id, i.product_id,
       (p.id is not null and c.plaats_id is not null and c.plaats_id <> p.id) as buiten_indeling
from gezin.diepvries_items i
left join gezin.diepvries_dozen d on d.id = i.doos_id
left join gezin.diepvries_plaatsen p on p.id = i.plaats_id
left join gezin.diepvries_categorieen c on c.id = i.categorie_id
where i.uit_op is null;

alter table gezin.diepvries_plaatsen    enable row level security;
alter table gezin.diepvries_categorieen enable row level security;
alter table gezin.diepvries_dozen       enable row level security;
alter table gezin.diepvries_items       enable row level security;

create policy plaatsen_rw on gezin.diepvries_plaatsen for all to authenticated
  using (gezin.is_lid(huishouden_id)) with check (gezin.is_lid(huishouden_id));

create policy categorieen_rw on gezin.diepvries_categorieen for all to authenticated
  using (gezin.is_lid(huishouden_id))
  with check (gezin.is_lid(huishouden_id)
    and (plaats_id is null or exists (select 1 from gezin.diepvries_plaatsen p
         where p.id = plaats_id and p.huishouden_id = diepvries_categorieen.huishouden_id)));

create policy dozen_rw on gezin.diepvries_dozen for all to authenticated
  using (gezin.is_lid(huishouden_id)) with check (gezin.is_lid(huishouden_id));

create policy items_rw on gezin.diepvries_items for all to authenticated
  using (gezin.is_lid(huishouden_id))
  with check (gezin.is_lid(huishouden_id)
    and (gerecht_id   is null or exists (select 1 from gezin.gerechten g where g.id = gerecht_id and g.huishouden_id = diepvries_items.huishouden_id))
    and (product_id   is null or exists (select 1 from gezin.producten x where x.id = product_id and x.huishouden_id = diepvries_items.huishouden_id))
    and (categorie_id is null or exists (select 1 from gezin.diepvries_categorieen c where c.id = categorie_id and c.huishouden_id = diepvries_items.huishouden_id))
    and (plaats_id    is null or exists (select 1 from gezin.diepvries_plaatsen p where p.id = plaats_id and p.huishouden_id = diepvries_items.huishouden_id))
    and (doos_id      is null or exists (select 1 from gezin.diepvries_dozen d where d.id = doos_id and d.huishouden_id = diepvries_items.huishouden_id and d.actief)));

revoke all on gezin.diepvries_plaatsen, gezin.diepvries_categorieen, gezin.diepvries_dozen,
              gezin.diepvries_items, gezin.v_diepvries from public, anon;
grant select, insert, update, delete on gezin.diepvries_plaatsen, gezin.diepvries_categorieen,
              gezin.diepvries_dozen, gezin.diepvries_items to authenticated;
grant select on gezin.v_diepvries to authenticated;

revoke all on function gezin.diepvries_aanvullen(), gezin.diepvries_standaard(uuid),
                       gezin.diepvries_standaard_trigger(), gezin.diepvries_log(),
                       gezin.diepvries_dozen_toevoegen(uuid, int, int, text),
                       gezin.diepvries_uit(uuid, numeric), gezin.diepvries_doos(uuid, text)
  from public, anon;
grant execute on function gezin.diepvries_dozen_toevoegen(uuid, int, int, text),
                          gezin.diepvries_uit(uuid, numeric), gezin.diepvries_doos(uuid, text)
  to authenticated;

select gezin.diepvries_standaard(id) from gezin.huishoudens;

alter publication supabase_realtime add table
  gezin.diepvries_items, gezin.diepvries_plaatsen, gezin.diepvries_categorieen;

-- ===== 20261111a_gezin_voorraad.sql

create table gezin.voorraad_ruimtes (
  id            uuid primary key default gen_random_uuid(),
  huishouden_id uuid not null references gezin.huishoudens on delete cascade,
  code          text not null check (length(trim(code)) between 1 and 6),
  naam          text not null check (length(trim(naam)) between 1 and 60),
  soort         text not null default 'rek' check (soort in ('koelkast', 'rek', 'kast', 'andere')),
  planken       smallint not null default 0 check (planken between 0 and 12),
  volgorde      int not null default 0,
  actief        boolean not null default true,
  unique (huishouden_id, code)
);

create table gezin.voorraad_categorieen (
  id             uuid primary key default gen_random_uuid(),
  huishouden_id  uuid not null references gezin.huishoudens on delete cascade,
  naam           text not null check (length(trim(naam)) between 1 and 60),
  ruimte_id      uuid references gezin.voorraad_ruimtes on delete set null,
  plank          smallint check (plank between 1 and 12),
  houdbaar_dagen smallint check (houdbaar_dagen between 1 and 999),
  volgorde       int not null default 0,
  unique (huishouden_id, naam)
);

alter table gezin.producten
  add column winkel text,
  add column bestemming text check (bestemming in ('voorraad', 'diepvries', 'niet')),
  add column voorraad_categorie_id uuid references gezin.voorraad_categorieen on delete set null,
  add column diepvries_categorie_id uuid references gezin.diepvries_categorieen on delete set null;

create table gezin.winkel_codes (
  huishouden_id uuid not null references gezin.huishoudens on delete cascade,
  winkel        text not null,
  artnr         text not null,
  product_id    uuid not null references gezin.producten on delete cascade,
  primary key (huishouden_id, winkel, artnr)
);

create table gezin.tickets (
  id            uuid primary key default gen_random_uuid(),
  huishouden_id uuid not null references gezin.huishoudens on delete cascade,
  sleutel       text not null,
  winkel        jsonb not null,
  datum         date not null,
  tijd          text,
  totaal        int,
  som           int,
  lijnen        jsonb not null check (jsonb_typeof(lijnen) = 'array'),
  betalingen    jsonb not null default '[]',
  status        text not null default 'binnengekomen' check (status in ('binnengekomen', 'verwerkt', 'verwijderd')),
  ingelezen     timestamptz not null default now(),
  ingelezen_door uuid default auth.uid(),
  verwerkt_op   timestamptz
);
create unique index tickets_eenmaal on gezin.tickets (huishouden_id, sleutel) where status <> 'verwijderd';

create table gezin.voorraad_items (
  id            uuid primary key default gen_random_uuid(),
  huishouden_id uuid not null references gezin.huishoudens on delete cascade,
  product_id    uuid references gezin.producten on delete set null,
  naam          text not null check (length(trim(naam)) between 1 and 120),
  categorie_id  uuid references gezin.voorraad_categorieen on delete set null,
  ruimte_id     uuid references gezin.voorraad_ruimtes on delete set null,
  plank         smallint check (plank between 1 and 12),
  aantal        numeric(10,3) not null check (aantal > 0),
  eenheid       text not null default 'stuk' check (eenheid in ('stuk', 'kg', 'pak', 'fles', 'blik')),
  binnen_op     date not null default current_date,
  eet_voor      date,
  op_op         timestamptz,
  ticket_id     uuid references gezin.tickets on delete set null,
  aangemaakt    timestamptz not null default now(),
  gewijzigd     timestamptz not null default now()
);
create index on gezin.voorraad_items (huishouden_id) where op_op is null;
create index on gezin.voorraad_items (product_id) where op_op is null;
create trigger voorraad_items_gewijzigd before update on gezin.voorraad_items
  for each row execute function gezin.zet_gewijzigd();

alter table gezin.diepvries_items add column ticket_id uuid references gezin.tickets on delete set null;

create function gezin.voorraad_standaard(p_huishouden uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from gezin.voorraad_ruimtes where huishouden_id = p_huishouden) then return; end if;
  insert into gezin.voorraad_ruimtes (huishouden_id, code, naam, soort, planken, volgorde) values
    (p_huishouden, 'KK', 'Koelkast keuken', 'koelkast', 0, 1),
    (p_huishouden, 'KB', 'Koelkast berging', 'koelkast', 0, 2),
    (p_huishouden, 'R1', 'Rek 1 · voeding en drank', 'rek', 5, 3),
    (p_huishouden, 'R2', 'Rek 2 · schoonmaak en drank', 'rek', 5, 4),
    (p_huishouden, 'R3', 'Rek 3 · huishouden', 'rek', 5, 5);
  insert into gezin.voorraad_categorieen (huishouden_id, naam, ruimte_id, plank, houdbaar_dagen, volgorde)
  select p_huishouden, c.naam, r.id, c.plank, c.dagen, c.volg
  from (values ('Zuivel en eieren', 'KK', null::smallint, 10::smallint, 1), ('Kaas en charcuterie', 'KK', null, 7, 2),
               ('Vers vlees en vis', 'KK', null, 3, 3), ('Groenten en fruit', 'KK', null, 7, 4), ('Sauzen (open)', 'KK', null, null, 5),
               ('Koude drank', 'KB', null, null, 6), ('Water, melk en frisdrank', 'R1', 2, null, 7), ('Brood, fruit en koekjes', 'R1', 3, null, 8),
               ('Ontbijt, beleg en conserven', 'R1', 4, null, 9), ('Wijn en olie', 'R1', 5, null, 10), ('Koffie, thee en suiker', 'R2', 4, null, 11),
               ('Schoonmaak en was', 'R2', 3, null, 12), ('Bier en frisdrank (bak)', 'R2', 5, null, 13), ('Huishouden', 'R3', 2, null, 14),
               ('Verzorging', 'R3', 2, null, 15), ('Aardappelen en uien', 'R1', 3, null, 16)) c(naam, code, plank, dagen, volg)
  join gezin.voorraad_ruimtes r on r.huishouden_id = p_huishouden and r.code = c.code;
end;
$$;
create function gezin.voorraad_standaard_trigger()
returns trigger language plpgsql security definer set search_path = ''
as $$ begin perform gezin.voorraad_standaard(new.id); return new; end; $$;
create trigger huishouden_voorraad after insert on gezin.huishoudens
  for each row execute function gezin.voorraad_standaard_trigger();

create function gezin.ticket_verwerken(p_ticket uuid, p_keuzes jsonb)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  t gezin.tickets; k jsonb; l jsonb; v_pid uuid; v_cg boolean; v_winkel text;
  v_cat gezin.voorraad_categorieen; v_item uuid; v_eet date;
  n_vr int := 0; n_dv int := 0; n_nieuw int := 0; v_naam text; v_kg boolean;
begin
  select * into t from gezin.tickets where id = p_ticket for update;
  if not found then raise exception 'Ticket niet gevonden'; end if;
  if t.status <> 'binnengekomen' then raise exception 'Dit ticket is al verwerkt'; end if;
  v_cg := coalesce((t.winkel->>'cg_nummers')::boolean, false);
  v_winkel := t.winkel->>'code';
  for k in select * from jsonb_array_elements(p_keuzes) loop
    l := t.lijnen -> ((k->>'lijn')::int);
    if l is null then raise exception 'Onbekende lijn %', k->>'lijn'; end if;
    v_kg := l->>'eenheid' = 'kg';
    v_pid := nullif(k->>'product_id', '')::uuid;
    if v_pid is null and v_cg then
      select id into v_pid from gezin.producten where huishouden_id = t.huishouden_id and cg_product_id = l->>'artnr';
    end if;
    if v_pid is null then
      insert into gezin.producten (huishouden_id, cg_product_id, naam, winkel, prijs, prijs_per)
      values (t.huishouden_id, case when v_cg then l->>'artnr' end, l->>'naam', case when v_cg then null else v_winkel end,
              ((l->>'eenheidsprijs')::numeric / 100), case when v_kg then 'kg' else 'stuk' end)
      returning id into v_pid;
      n_nieuw := n_nieuw + 1;
    elsif v_cg and l->>'eenheidsprijs' is not null then
      update gezin.producten set prijs = (l->>'eenheidsprijs')::numeric / 100, bijgewerkt = now() where id = v_pid;
    end if;
    if not v_cg then
      insert into gezin.winkel_codes (huishouden_id, winkel, artnr, product_id) values (t.huishouden_id, v_winkel, l->>'artnr', v_pid)
      on conflict (huishouden_id, winkel, artnr) do update set product_id = excluded.product_id;
    end if;
    update gezin.producten set bestemming = k->>'soort',
      voorraad_categorie_id  = case when k->>'soort' = 'voorraad'  then nullif(k->>'categorie_id', '')::uuid end,
      diepvries_categorie_id = case when k->>'soort' = 'diepvries' then nullif(k->>'categorie_id', '')::uuid end
    where id = v_pid;
    select naam into v_naam from gezin.producten where id = v_pid;
    if k->>'soort' = 'voorraad' then
      select * into v_cat from gezin.voorraad_categorieen where id = nullif(k->>'categorie_id', '')::uuid;
      v_eet := case when v_cat.houdbaar_dagen is not null then t.datum + v_cat.houdbaar_dagen end;
      select id into v_item from gezin.voorraad_items
       where huishouden_id = t.huishouden_id and op_op is null and product_id = v_pid
         and categorie_id is not distinct from v_cat.id and eenheid = case when v_kg then 'kg' else 'stuk' end
       limit 1;
      if v_item is not null then
        update gezin.voorraad_items set aantal = aantal + (l->>'aantal')::numeric, binnen_op = t.datum,
          eet_voor = coalesce(eet_voor, v_eet) where id = v_item;
      else
        insert into gezin.voorraad_items (huishouden_id, product_id, naam, categorie_id, ruimte_id, plank, aantal, eenheid, binnen_op, eet_voor, ticket_id)
        values (t.huishouden_id, v_pid, v_naam, v_cat.id, v_cat.ruimte_id, v_cat.plank, (l->>'aantal')::numeric,
                case when v_kg then 'kg' else 'stuk' end, t.datum, v_eet, t.id);
      end if;
      n_vr := n_vr + 1;
    elsif k->>'soort' = 'diepvries' then
      insert into gezin.diepvries_items (huishouden_id, soort, product_id, naam, categorie_id, aantal, eenheid, ingevroren_op, ticket_id)
      values (t.huishouden_id, 'product', v_pid, v_naam, nullif(k->>'categorie_id', '')::uuid,
              case when v_kg then round((l->>'aantal')::numeric * 1000) else (l->>'aantal')::numeric end,
              case when v_kg then 'g' else 'stuk' end, t.datum, t.id);
      n_dv := n_dv + 1;
    elsif k->>'soort' <> 'niet' then
      raise exception 'Onbekende bestemming %', k->>'soort';
    end if;
  end loop;
  update gezin.tickets set status = 'verwerkt', verwerkt_op = now() where id = t.id;
  perform gezin.voorraad_log(t.huishouden_id, format('las het ticket van %s (%s) in: %s op voorraad, %s in de diepvries',
                                                    t.winkel->>'naam', to_char(t.datum, 'DD/MM'), n_vr, n_dv));
  return jsonb_build_object('nVr', n_vr, 'nDv', n_dv, 'nNieuw', n_nieuw);
end;
$$;

create function gezin.voorraad_log(p_huishouden uuid, p_wat text)
returns void language plpgsql security definer set search_path = ''
as $$ begin
  if not gezin.is_lid(p_huishouden) then raise exception 'Geen toegang tot dit gezin'; end if;
  perform gezin.log(p_huishouden, p_wat);
end; $$;

create function gezin.voorraad_gebruik(p_item uuid, p_aantal numeric default null)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare v gezin.voorraad_items;
begin
  select * into v from gezin.voorraad_items where id = p_item for update;
  if not found then raise exception 'Niet gevonden'; end if;
  if v.op_op is not null then return jsonb_build_object('fout', 'Al op'); end if;
  if p_aantal is not null and p_aantal <= 0 then raise exception 'Aantal moet positief zijn'; end if;
  if p_aantal is null or p_aantal >= v.aantal then
    update gezin.voorraad_items set op_op = now() where id = p_item;
    return jsonb_build_object('rest', 0);
  end if;
  update gezin.voorraad_items set aantal = aantal - p_aantal where id = p_item;
  return jsonb_build_object('rest', v.aantal - p_aantal);
end;
$$;

alter table gezin.voorraad_ruimtes     enable row level security;
alter table gezin.voorraad_categorieen enable row level security;
alter table gezin.winkel_codes         enable row level security;
alter table gezin.tickets              enable row level security;
alter table gezin.voorraad_items       enable row level security;

create policy ruimtes_rw on gezin.voorraad_ruimtes for all to authenticated
  using (gezin.is_lid(huishouden_id)) with check (gezin.is_lid(huishouden_id));
create policy vcat_rw on gezin.voorraad_categorieen for all to authenticated
  using (gezin.is_lid(huishouden_id))
  with check (gezin.is_lid(huishouden_id)
    and (ruimte_id is null or exists (select 1 from gezin.voorraad_ruimtes r where r.id = ruimte_id and r.huishouden_id = voorraad_categorieen.huishouden_id)));
create policy codes_rw on gezin.winkel_codes for all to authenticated
  using (gezin.is_lid(huishouden_id))
  with check (gezin.is_lid(huishouden_id)
    and exists (select 1 from gezin.producten p where p.id = product_id and p.huishouden_id = winkel_codes.huishouden_id));
create policy tickets_rw on gezin.tickets for all to authenticated
  using (gezin.is_lid(huishouden_id)) with check (gezin.is_lid(huishouden_id));
create policy vitems_rw on gezin.voorraad_items for all to authenticated
  using (gezin.is_lid(huishouden_id))
  with check (gezin.is_lid(huishouden_id)
    and (product_id   is null or exists (select 1 from gezin.producten x where x.id = product_id and x.huishouden_id = voorraad_items.huishouden_id))
    and (categorie_id is null or exists (select 1 from gezin.voorraad_categorieen c where c.id = categorie_id and c.huishouden_id = voorraad_items.huishouden_id))
    and (ruimte_id    is null or exists (select 1 from gezin.voorraad_ruimtes r where r.id = ruimte_id and r.huishouden_id = voorraad_items.huishouden_id))
    and (ticket_id    is null or exists (select 1 from gezin.tickets t where t.id = ticket_id and t.huishouden_id = voorraad_items.huishouden_id)));

create policy producten_bestemming on gezin.producten as restrictive for all to authenticated
  using (true)
  with check ((voorraad_categorie_id is null or exists (select 1 from gezin.voorraad_categorieen c where c.id = voorraad_categorie_id and c.huishouden_id = producten.huishouden_id))
          and (diepvries_categorie_id is null or exists (select 1 from gezin.diepvries_categorieen c where c.id = diepvries_categorie_id and c.huishouden_id = producten.huishouden_id)));

create policy diepvries_ticket on gezin.diepvries_items as restrictive for all to authenticated
  using (true)
  with check (ticket_id is null or exists (select 1 from gezin.tickets t where t.id = ticket_id and t.huishouden_id = diepvries_items.huishouden_id));

revoke all on gezin.voorraad_ruimtes, gezin.voorraad_categorieen, gezin.winkel_codes, gezin.tickets, gezin.voorraad_items from public, anon;
grant select, insert, update, delete on gezin.voorraad_ruimtes, gezin.voorraad_categorieen, gezin.winkel_codes,
  gezin.tickets, gezin.voorraad_items to authenticated;

revoke all on function gezin.voorraad_standaard(uuid), gezin.voorraad_standaard_trigger(), gezin.ticket_verwerken(uuid, jsonb),
                       gezin.voorraad_gebruik(uuid, numeric), gezin.voorraad_log(uuid, text) from public, anon;
grant execute on function gezin.ticket_verwerken(uuid, jsonb), gezin.voorraad_gebruik(uuid, numeric), gezin.voorraad_log(uuid, text) to authenticated;

select gezin.voorraad_standaard(id) from gezin.huishoudens;

alter publication supabase_realtime add table gezin.voorraad_items, gezin.tickets;

-- ===== 20261111b_gezin_weekvoorstel.sql

alter table gezin.afspraken add column maaltijd text check (maaltijd in ('niet_mee', 'geen_thuis'));

create table gezin.instellingen (
  huishouden_id uuid primary key references gezin.huishoudens on delete cascade,
  weekvoorstel  jsonb not null default '{}',
  gewijzigd     timestamptz not null default now(),
  gewijzigd_door uuid
);
alter table gezin.instellingen enable row level security;
create policy instellingen_lezen on gezin.instellingen for select to authenticated using (gezin.is_lid(huishouden_id));
revoke all on gezin.instellingen from public, anon;
grant select on gezin.instellingen to authenticated;

create function gezin.bewaar_weekvoorstel_instellingen(p_huishouden uuid, p jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v jsonb;
begin
  if not exists (select 1 from gezin.leden where huishouden_id = p_huishouden and user_id = (select auth.uid()) and rol = 'beheerder') then
    raise exception 'Enkel de beheerder kan het weekvoorstel instellen';
  end if;
  v := jsonb_strip_nulls(jsonb_build_object(
    'automatisch', (p->>'automatisch')::boolean,
    'dag', (p->>'dag')::int, 'startdag', (p->>'startdag')::int, 'dagen', coalesce((p->>'dagen')::int, 7),
    'eters', (p->>'eters')::int, 'weekendMoment', p->>'weekendMoment', 'nietHerhalenWeken', (p->>'nietHerhalenWeken')::int,
    'uitgesloten', coalesce(p->'uitgesloten', '[]'), 'uitgeslotenWoorden', coalesce(p->'uitgeslotenWoorden', '[]')));
  if (v->>'dag')::int not between 1 and 7 or (v->>'startdag')::int not between 1 and 7 or v->>'dag' = v->>'startdag' then
    raise exception 'Overlegdag en startdag: 1–7 en verschillend';
  end if;
  if (v->>'dagen')::int not between 1 and 14 then raise exception 'Dagen: 1–14'; end if;
  if v ? 'eters' and (v->>'eters')::int not between 1 and 20 then raise exception 'Eters: 1–20'; end if;
  if v->>'weekendMoment' not in ('avond', 'middag') then raise exception 'Weekend: avond of middag'; end if;
  if (v->>'nietHerhalenWeken')::int not between 1 and 12 then raise exception 'Niet herhalen: 1–12 weken'; end if;
  if jsonb_typeof(v->'uitgesloten') <> 'array' or jsonb_typeof(v->'uitgeslotenWoorden') <> 'array' then raise exception 'Uitgesloten: lijst verwacht'; end if;
  insert into gezin.instellingen (huishouden_id, weekvoorstel, gewijzigd, gewijzigd_door)
  values (p_huishouden, v, now(), (select auth.uid()))
  on conflict (huishouden_id) do update set weekvoorstel = excluded.weekvoorstel, gewijzigd = now(), gewijzigd_door = excluded.gewijzigd_door;
end;
$$;
revoke all on function gezin.bewaar_weekvoorstel_instellingen(uuid, jsonb) from public, anon;
grant execute on function gezin.bewaar_weekvoorstel_instellingen(uuid, jsonb) to authenticated;

create table gezin.weekvoorstellen (
  id            uuid primary key default gen_random_uuid(),
  huishouden_id uuid not null references gezin.huishoudens on delete cascade,
  start         date not null,
  dagen         jsonb not null check (jsonb_typeof(dagen) = 'array'),
  uitsluiten    jsonb not null default '{}',
  status        text not null default 'voorstel' check (status in ('voorstel', 'overgenomen')),
  gemaakt       timestamptz not null default now(),
  unique (huishouden_id, start)
);
alter table gezin.weekvoorstellen enable row level security;
create policy voorstellen_rw on gezin.weekvoorstellen for all to authenticated
  using (gezin.is_lid(huishouden_id)) with check (gezin.is_lid(huishouden_id));
revoke all on gezin.weekvoorstellen from public, anon;
grant select, insert, update, delete on gezin.weekvoorstellen to authenticated;

alter publication supabase_realtime add table gezin.weekvoorstellen;

-- ===== 20261111c_gezin_bestellijst.sql
alter table gezin.boodschappen_extra drop constraint if exists boodschappen_extra_week_start_check;
comment on column gezin.boodschappen_extra.week_start is 'Eerste dag van de planweek (instelling weekvoorstel.startdag)';
comment on column gezin.boodschappen_afgevinkt.week_start is 'Eerste dag van de planweek; sleutel ''bestel:…'' = toch bestellen ondanks voorraad';
-- ===== 20261111d_gezin_overleg_kind_google.sql

alter table gezin.taken add column eigenaar_id uuid references gezin.leden on delete set null;
alter table gezin.taken add column picto text check (picto is null or length(picto) between 1 and 16);
alter table gezin.taken add column duur_min smallint check (duur_min between 1 and 180);
create index on gezin.taken (huishouden_id, eigenaar_id);

drop policy taken_rw on gezin.taken;
create policy taken_rw on gezin.taken for all to authenticated
  using (gezin.is_lid(huishouden_id))
  with check (gezin.is_lid(huishouden_id)
    and (lid_id is null or exists (select 1 from gezin.leden l where l.id = lid_id and l.huishouden_id = taken.huishouden_id))
    and (eigenaar_id is null or exists (select 1 from gezin.leden l where l.id = eigenaar_id and l.huishouden_id = taken.huishouden_id)));

alter table gezin.taak_klaar add column door_lid uuid references gezin.leden on delete set null;
drop policy taak_klaar_rw on gezin.taak_klaar;
create policy taak_klaar_rw on gezin.taak_klaar for all to authenticated
  using (gezin.is_lid(huishouden_id))
  with check (gezin.is_lid(huishouden_id)
    and exists (select 1 from gezin.taken t where t.id = taak_id and t.huishouden_id = taak_klaar.huishouden_id)
    and (door_lid is null or exists (select 1 from gezin.leden l where l.id = door_lid and l.huishouden_id = taak_klaar.huishouden_id)));

create table gezin.weekoverleggen (
  id            uuid primary key default gen_random_uuid(),
  huishouden_id uuid not null references gezin.huishoudens on delete cascade,
  start         date not null,
  stap          smallint not null default 1 check (stap between 1 and 5),
  notities      text check (length(notities) <= 4000),
  samenvatting  jsonb not null default '{}' check (jsonb_typeof(samenvatting) = 'object'),
  afgerond      timestamptz,
  afgerond_door uuid references gezin.leden on delete set null,
  aangemaakt    timestamptz not null default now(),
  gewijzigd     timestamptz not null default now(),
  unique (huishouden_id, start)
);
create trigger weekoverleggen_gewijzigd before update on gezin.weekoverleggen
  for each row execute function gezin.zet_gewijzigd();
alter table gezin.weekoverleggen enable row level security;
create policy overleggen_rw on gezin.weekoverleggen for all to authenticated
  using (gezin.is_lid(huishouden_id))
  with check (gezin.is_lid(huishouden_id)
    and (afgerond_door is null or exists (select 1 from gezin.leden l where l.id = afgerond_door and l.huishouden_id = weekoverleggen.huishouden_id)));
revoke all on gezin.weekoverleggen from public, anon;
grant select, insert, update, delete on gezin.weekoverleggen to authenticated;

alter table gezin.leden drop constraint leden_rol_check;
alter table gezin.leden add constraint leden_rol_check check (rol in ('beheerder', 'lid', 'kind'));
alter table gezin.leden add constraint leden_kind_zonder_account check (rol <> 'kind' or user_id is null);
alter table gezin.leden add column avatar text check (avatar is null or length(avatar) between 1 and 16);

create table gezin.pincodes (
  id              uuid primary key default gen_random_uuid(),
  huishouden_id   uuid not null references gezin.huishoudens on delete cascade,
  soort           text not null check (soort in ('kind', 'ouder')),
  lid_id          uuid references gezin.leden on delete cascade,
  pin_hash        text not null,
  pogingen        smallint not null default 0,
  geblokkeerd_tot timestamptz,
  gewijzigd       timestamptz not null default now(),
  check ((soort = 'kind') = (lid_id is not null))
);
create unique index pincodes_kind on gezin.pincodes (lid_id) where soort = 'kind';
create unique index pincodes_ouder on gezin.pincodes (huishouden_id) where soort = 'ouder';
alter table gezin.pincodes enable row level security;
revoke all on gezin.pincodes from public, anon, authenticated;

create function gezin.is_beheerder(p_huishouden uuid)
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from gezin.leden where huishouden_id = p_huishouden and user_id = (select auth.uid()) and rol = 'beheerder') $$;

create function gezin.bewaar_kindprofiel(p_lid uuid, p_kind boolean, p_avatar text, p_pin text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v gezin.leden;
begin
  select * into v from gezin.leden where id = p_lid;
  if not found or not gezin.is_beheerder(v.huishouden_id) then raise exception 'Enkel de beheerder kan kindprofielen instellen'; end if;
  if p_kind and v.user_id is not null then raise exception 'Een lid met een eigen account kan geen kindprofiel zijn'; end if;
  if p_pin is not null and p_pin !~ '^[0-9]{4}$' then raise exception 'Pincode: 4 cijfers'; end if;
  if p_avatar is not null and length(p_avatar) > 16 then raise exception 'Avatar te lang'; end if;
  update gezin.leden set rol = case when p_kind then 'kind' when rol = 'kind' then 'lid' else rol end,
                         avatar = nullif(trim(coalesce(p_avatar, '')), '')
   where id = p_lid;
  if not p_kind then
    delete from gezin.pincodes where lid_id = p_lid and soort = 'kind';
  elsif p_pin is not null then
    insert into gezin.pincodes (huishouden_id, soort, lid_id, pin_hash)
    values (v.huishouden_id, 'kind', p_lid, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)))
    on conflict (lid_id) where soort = 'kind'
    do update set pin_hash = excluded.pin_hash, pogingen = 0, geblokkeerd_tot = null, gewijzigd = now();
  end if;
end;
$$;

create function gezin.bewaar_ouderpin(p_huishouden uuid, p_pin text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not gezin.is_beheerder(p_huishouden) then raise exception 'Enkel de beheerder kan de ouderpincode instellen'; end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then raise exception 'Ouderpincode: 4 tot 6 cijfers'; end if;
  insert into gezin.pincodes (huishouden_id, soort, pin_hash)
  values (p_huishouden, 'ouder', extensions.crypt(p_pin, extensions.gen_salt('bf', 8)))
  on conflict (huishouden_id) where soort = 'ouder'
  do update set pin_hash = excluded.pin_hash, pogingen = 0, geblokkeerd_tot = null, gewijzigd = now();
end;
$$;

create function gezin.controleer_pin(p_huishouden uuid, p_lid uuid, p_pin text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare v gezin.pincodes;
begin
  if not gezin.is_lid(p_huishouden) then raise exception 'Geen toegang tot dit gezin'; end if;
  select * into v from gezin.pincodes
   where huishouden_id = p_huishouden
     and ((p_lid is null and soort = 'ouder') or (p_lid is not null and soort = 'kind' and lid_id = p_lid))
   for update;
  if not found then return 'geen'; end if;
  if v.geblokkeerd_tot is not null and v.geblokkeerd_tot > now() then return 'geblokkeerd'; end if;
  if v.pin_hash = extensions.crypt(coalesce(p_pin, ''), v.pin_hash) then
    update gezin.pincodes set pogingen = 0, geblokkeerd_tot = null where id = v.id;
    return 'ok';
  end if;
  update gezin.pincodes set pogingen = case when pogingen + 1 >= 5 then 0 else pogingen + 1 end,
         geblokkeerd_tot = case when pogingen + 1 >= 5 then now() + interval '5 minutes' else geblokkeerd_tot end
   where id = v.id;
  return case when v.pogingen + 1 >= 5 then 'geblokkeerd' else 'fout' end;
end;
$$;

create function gezin.kindmodus_info(p_huishouden uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when not gezin.is_lid(p_huishouden) then null else jsonb_build_object(
    'ouderpin', exists (select 1 from gezin.pincodes where huishouden_id = p_huishouden and soort = 'ouder'),
    'kinderen', coalesce((select jsonb_agg(p.lid_id) from gezin.pincodes p where p.huishouden_id = p_huishouden and p.soort = 'kind'), '[]'::jsonb)) end
$$;

alter table gezin.afspraken add column bron text check (bron in ('google'));

create table gezin.google_koppelingen (
  id                 uuid primary key default gen_random_uuid(),
  huishouden_id      uuid not null references gezin.huishoudens on delete cascade,
  lid_id             uuid not null references gezin.leden on delete cascade,
  google_email       text,
  google_kalender_id text,
  doel_kalender_id   uuid references gezin.kalenders on delete set null,
  sync_token         text,
  vault_secret_id    uuid,
  actief             boolean not null default true,
  laatst_gesync      timestamptz,
  laatste_fout       text,
  bezig_tot          timestamptz,
  aangemaakt         timestamptz not null default now(),
  unique (huishouden_id, lid_id)
);

create table gezin.google_events (
  koppeling_id     uuid not null references gezin.google_koppelingen on delete cascade,
  afspraak_id      uuid not null references gezin.afspraken on delete cascade,
  huishouden_id    uuid not null references gezin.huishoudens on delete cascade,
  google_id        text not null,
  etag             text,
  google_gewijzigd timestamptz,
  kring_gewijzigd  timestamptz,
  alleen_lezen     boolean not null default false,
  primary key (koppeling_id, afspraak_id),
  unique (koppeling_id, google_id)
);
create index on gezin.google_events (afspraak_id);

create table gezin.google_wissen (
  koppeling_id uuid not null references gezin.google_koppelingen on delete cascade,
  google_id    text not null,
  op           timestamptz not null default now(),
  primary key (koppeling_id, google_id)
);

create table gezin.google_oauth_state (
  state         text primary key,
  huishouden_id uuid not null references gezin.huishoudens on delete cascade,
  lid_id        uuid not null references gezin.leden on delete cascade,
  gemaakt       timestamptz not null default now()
);

create function gezin.google_wis_trigger()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into gezin.google_wissen (koppeling_id, google_id)
  select koppeling_id, google_id from gezin.google_events where afspraak_id = old.id and not alleen_lezen
  on conflict do nothing;
  return old;
end;
$$;
create trigger afspraken_google_wissen before delete on gezin.afspraken
  for each row execute function gezin.google_wis_trigger();

alter table gezin.google_koppelingen enable row level security;
alter table gezin.google_events      enable row level security;
alter table gezin.google_wissen      enable row level security;
alter table gezin.google_oauth_state enable row level security;
create policy koppelingen_lezen on gezin.google_koppelingen for select to authenticated using (gezin.is_lid(huishouden_id));
create policy google_events_lezen on gezin.google_events for select to authenticated using (gezin.is_lid(huishouden_id));
revoke all on gezin.google_koppelingen, gezin.google_events, gezin.google_wissen, gezin.google_oauth_state from public, anon, authenticated;
grant select (id, huishouden_id, lid_id, google_email, doel_kalender_id, actief, laatst_gesync, laatste_fout, aangemaakt)
  on gezin.google_koppelingen to authenticated;
grant select (afspraak_id, huishouden_id, koppeling_id, alleen_lezen) on gezin.google_events to authenticated;

create function gezin.google_doelkalender(p_koppeling uuid, p_kalender uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_h uuid;
begin
  select huishouden_id into v_h from gezin.google_koppelingen where id = p_koppeling;
  if v_h is null or not gezin.is_lid(v_h) then raise exception 'Geen toegang'; end if;
  if not exists (select 1 from gezin.kalenders where id = p_kalender and huishouden_id = v_h and soort = 'eigen') then raise exception 'Kies een eigen agenda van het gezin'; end if;
  update gezin.google_koppelingen set doel_kalender_id = p_kalender where id = p_koppeling;
end;
$$;

create function gezin.google_token_bewaar(p_koppeling uuid, p_token text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  select vault_secret_id into v_id from gezin.google_koppelingen where id = p_koppeling;
  if not found then raise exception 'Koppeling niet gevonden'; end if;
  if v_id is null then
    v_id := vault.create_secret(p_token, 'kring_google_' || p_koppeling::text, 'Google refresh token Kring');
    update gezin.google_koppelingen set vault_secret_id = v_id where id = p_koppeling;
  else
    perform vault.update_secret(v_id, p_token);
  end if;
end;
$$;
create function gezin.google_token(p_koppeling uuid)
returns text
language sql stable security definer set search_path = ''
as $$ select s.decrypted_secret from gezin.google_koppelingen k join vault.decrypted_secrets s on s.id = k.vault_secret_id where k.id = p_koppeling $$;
create function gezin.google_koppeling_wissen(p_koppeling uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  select vault_secret_id into v_id from gezin.google_koppelingen where id = p_koppeling;
  delete from gezin.google_koppelingen where id = p_koppeling;
  if v_id is not null then delete from vault.secrets where id = v_id; end if;
end;
$$;

create or replace function gezin.log_trigger()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_lijst gezin.lijsten;
begin
  if tg_table_name = 'lijst_items' then
    select * into v_lijst from gezin.lijsten where id = new.lijst_id;
    if v_lijst.prive then return new; end if;
    if tg_op = 'INSERT' then perform gezin.log(new.huishouden_id, format('zette ''%s'' op %s', new.tekst, v_lijst.naam));
    elsif new.klaar and not old.klaar then perform gezin.log(new.huishouden_id, format('vinkte ''%s'' af op %s', new.tekst, v_lijst.naam)); end if;
  elsif tg_table_name = 'taak_klaar' then
    if new.door_lid is not null then
      insert into gezin.activiteit (huishouden_id, wie, wat)
      values (new.huishouden_id, coalesce((select naam from gezin.leden where id = new.door_lid), 'Iemand'),
              left(format('vinkte ''%s'' af', (select titel from gezin.taken where id = new.taak_id)), 300));
    else
      perform gezin.log(new.huishouden_id, format('vinkte ''%s'' af', (select titel from gezin.taken where id = new.taak_id)));
    end if;
  elsif tg_table_name = 'afspraken' and tg_op = 'INSERT' and new.ics_uid is null then
    if new.bron = 'google' then
      insert into gezin.activiteit (huishouden_id, wie, wat) values (new.huishouden_id, 'Google Agenda', left(format('plande ''%s''', new.titel), 300));
    else
      perform gezin.log(new.huishouden_id, format('plande ''%s''', new.titel));
    end if;
  elsif tg_table_name = 'weekmenu' and new.gerecht_id is not null then
    perform gezin.log(new.huishouden_id, format('zette ''%s'' op het menu', (select naam from gezin.gerechten where id = new.gerecht_id)));
  end if;
  return new;
end;
$$;

revoke all on function gezin.is_beheerder(uuid), gezin.bewaar_kindprofiel(uuid, boolean, text, text), gezin.bewaar_ouderpin(uuid, text),
  gezin.controleer_pin(uuid, uuid, text), gezin.kindmodus_info(uuid), gezin.google_doelkalender(uuid, uuid),
  gezin.google_token_bewaar(uuid, text), gezin.google_token(uuid), gezin.google_koppeling_wissen(uuid), gezin.google_wis_trigger() from public, anon;
grant execute on function gezin.is_beheerder(uuid), gezin.bewaar_kindprofiel(uuid, boolean, text, text), gezin.bewaar_ouderpin(uuid, text),
  gezin.controleer_pin(uuid, uuid, text), gezin.kindmodus_info(uuid), gezin.google_doelkalender(uuid, uuid) to authenticated;
revoke all on function gezin.google_token_bewaar(uuid, text), gezin.google_token(uuid), gezin.google_koppeling_wissen(uuid) from authenticated;

grant usage on schema gezin to service_role;
grant select, insert, update, delete on gezin.google_koppelingen, gezin.google_events, gezin.google_wissen, gezin.google_oauth_state,
  gezin.afspraken to service_role;
grant select on gezin.kalenders, gezin.leden, gezin.huishoudens to service_role;
grant execute on function gezin.google_token_bewaar(uuid, text), gezin.google_token(uuid), gezin.google_koppeling_wissen(uuid) to service_role;

alter publication supabase_realtime add table gezin.weekoverleggen;

-- ===== 20261111e_gezin_service_role_feed.sql
-- Kring – rechten voor de Edge Function agenda-feed (service_role, zonder login via token)
-- Zonder deze grants faalt de eerste query en geeft de feed altijd 404 "Onbekende link".
grant usage on schema gezin to service_role;
grant select on gezin.agenda_feed, gezin.afspraken, gezin.kalenders,
                gezin.taken, gezin.verjaardagen to service_role;
-- Testblok: draait na alle migraties in dezelfde transactie en eindigt ALTIJD met een fout,
-- zodat alles (schema, testgebruikers, testdata) wordt teruggedraaid.

-- Kring – fix log_trigger: PL/pgSQL evalueert "tg_table_name = 'afspraken' and ... new.ics_uid" niet kortsluitend.
-- Bij een insert in weekmenu gaf dat "record new has no field ics_uid" en mislukte het inplannen van elk gerecht.
-- Oplossing: per tabel eerst op naam vertakken, pas daarna velden van NEW lezen.
create or replace function gezin.log_trigger()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_lijst gezin.lijsten;
begin
  if tg_table_name = 'lijst_items' then
    select * into v_lijst from gezin.lijsten where id = new.lijst_id;
    if v_lijst.prive then return new; end if;
    if tg_op = 'INSERT' then
      perform gezin.log(new.huishouden_id, format('zette ''%s'' op %s', new.tekst, v_lijst.naam));
    elsif new.klaar and not old.klaar then
      perform gezin.log(new.huishouden_id, format('vinkte ''%s'' af op %s', new.tekst, v_lijst.naam));
    end if;
  elsif tg_table_name = 'taak_klaar' then
    if new.door_lid is not null then
      insert into gezin.activiteit (huishouden_id, wie, wat)
      values (new.huishouden_id, coalesce((select naam from gezin.leden where id = new.door_lid), 'Iemand'),
              left(format('vinkte ''%s'' af', (select titel from gezin.taken where id = new.taak_id)), 300));
    else
      perform gezin.log(new.huishouden_id, format('vinkte ''%s'' af', (select titel from gezin.taken where id = new.taak_id)));
    end if;
  elsif tg_table_name = 'afspraken' then
    if tg_op = 'INSERT' and new.ics_uid is null then
      if new.bron = 'google' then
        insert into gezin.activiteit (huishouden_id, wie, wat) values (new.huishouden_id, 'Google Agenda', left(format('plande ''%s''', new.titel), 300));
      else
        perform gezin.log(new.huishouden_id, format('plande ''%s''', new.titel));
      end if;
    end if;
  elsif tg_table_name = 'weekmenu' then
    if new.gerecht_id is not null then
      perform gezin.log(new.huishouden_id, format('zette ''%s'' op het menu', (select naam from gezin.gerechten where id = new.gerecht_id)));
    end if;
  end if;
  return new;
end;
$$;
revoke all on function gezin.log_trigger() from public, anon;
commit;
