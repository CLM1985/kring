-- =====================================================================
-- Kring – schema gezin, R3 Gezin: lijsten (to-do en vrije lijsten), activiteit,
-- agenda-feed voor Google Agenda
-- Versie 1 · 8/11/2026 (nog niet uitgevoerd; na 20261108_gezin_agenda.sql, eerst op een branch)
-- Additief: enkel schema "gezin".
-- =====================================================================

begin;

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

commit;
