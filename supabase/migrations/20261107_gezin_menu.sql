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

begin;

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

commit;

-- ---------- Controle na uitvoeren (read-only) -------------------------
-- select table_name from information_schema.tables where table_schema = 'gezin';
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_schema = 'gezin' and grantee in ('anon', 'public');   -- verwacht: 0 rijen
-- select count(*) from ynab.<een tabel>;                              -- ongewijzigd
