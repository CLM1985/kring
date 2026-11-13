-- =====================================================================
-- Kring – afvalkalender: wie zet buiten, afvinken, vervangdatum
-- Versie 1 · 13/11/2026 · na de afvalmigratie (afval_adres, afval_ophalingen, afval_sync)
--
-- Additief. Toewijzing en afvinken staan in eigen tabellen: de nachtelijke sync
-- wist en herschrijft de toekomstige rijen in afval_ophalingen.
-- =====================================================================

begin;

-- ---------- Vervangdatum (de oorspronkelijke datum bij een verplaatste ophaling)
alter table gezin.afval_ophalingen add column if not exists vervangt_datum date;

-- ---------- Vaste verantwoordelijke per fractie -------------------------
create table gezin.afval_verantwoordelijke (
  huishouden_id uuid not null references gezin.huishoudens(id) on delete cascade,
  fractie_id    text not null,
  lid_id        uuid not null references gezin.leden(id) on delete cascade,
  gewijzigd     timestamptz not null default now(),
  primary key (huishouden_id, fractie_id)
);

-- ---------- Per ophaling: andere persoon en/of buitengezet ---------------
-- Geen foreign key naar afval_ophalingen (de sync wist die rijen elke nacht).
-- datum + fractie_id dienen als terugval als Fost Plus het id ooit wijzigt.
create table gezin.afval_status (
  huishouden_id    uuid not null references gezin.huishoudens(id) on delete cascade,
  fostplus_id      text not null,
  datum            date not null,
  fractie_id       text,
  lid_id           uuid references gezin.leden(id) on delete set null,
  buitengezet_op   timestamptz,
  buitengezet_door uuid references gezin.leden(id) on delete set null,
  gewijzigd        timestamptz not null default now(),
  primary key (huishouden_id, fostplus_id)
);
create index afval_status_datum on gezin.afval_status (huishouden_id, datum, fractie_id);

alter table gezin.afval_verantwoordelijke enable row level security;
alter table gezin.afval_status enable row level security;
create policy afval_verantwoordelijke_lezen on gezin.afval_verantwoordelijke for select to authenticated using (gezin.is_lid(huishouden_id));
create policy afval_status_lezen on gezin.afval_status for select to authenticated using (gezin.is_lid(huishouden_id));
revoke all on gezin.afval_verantwoordelijke, gezin.afval_status from public, anon, authenticated;
grant select on gezin.afval_verantwoordelijke, gezin.afval_status to authenticated;

-- ---------- View voor de app: ophaling + wie + buitengezet ---------------
create view gezin.afval_agenda with (security_invoker = true) as
select o.huishouden_id, o.fostplus_id, o.datum, o.fractie_id, o.fractie, o.kleur, o.logo,
       o.reden_wijziging, o.vervangt_datum,
       v.lid_id                     as standaard_lid,
       s.lid_id                     as ander_lid,
       coalesce(s.lid_id, v.lid_id) as lid_id,
       s.buitengezet_op, s.buitengezet_door
  from gezin.afval_ophalingen o
  left join gezin.afval_verantwoordelijke v
         on v.huishouden_id = o.huishouden_id and v.fractie_id = o.fractie_id
  left join lateral (
        select st.* from gezin.afval_status st
         where st.huishouden_id = o.huishouden_id
           and (st.fostplus_id = o.fostplus_id or (st.datum = o.datum and st.fractie_id = o.fractie_id))
         order by (st.fostplus_id = o.fostplus_id) desc
         limit 1) s on true;
revoke all on gezin.afval_agenda from public, anon;
grant select on gezin.afval_agenda to authenticated;

-- ---------- Schrijven enkel via functies ---------------------------------
-- Vaste verantwoordelijke instellen (p_lid null = niemand)
create function gezin.afval_zet_verantwoordelijke(p_huishouden uuid, p_fractie_id text, p_lid uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_fractie text; v_naam text;
begin
  if not gezin.is_lid(p_huishouden) then raise exception 'Geen toegang tot dit gezin'; end if;
  select fractie into v_fractie from gezin.afval_ophalingen
   where huishouden_id = p_huishouden and fractie_id = p_fractie_id limit 1;
  if v_fractie is null then raise exception 'Onbekende afvalsoort'; end if;
  if p_lid is null then
    delete from gezin.afval_verantwoordelijke where huishouden_id = p_huishouden and fractie_id = p_fractie_id;
    perform gezin.log(p_huishouden, 'haalde de vaste verantwoordelijke voor ' || v_fractie || ' weg');
    return;
  end if;
  select naam into v_naam from gezin.leden where id = p_lid and huishouden_id = p_huishouden;
  if v_naam is null then raise exception 'Dit gezinslid hoort niet bij dit gezin'; end if;
  insert into gezin.afval_verantwoordelijke (huishouden_id, fractie_id, lid_id)
  values (p_huishouden, p_fractie_id, p_lid)
  on conflict (huishouden_id, fractie_id) do update set lid_id = excluded.lid_id, gewijzigd = now();
  perform gezin.log(p_huishouden, 'zette ' || v_naam || ' vast op ' || v_fractie);
end $$;

-- Eén ophaling aan iemand anders geven (p_lid null = terug naar de vaste verantwoordelijke)
create function gezin.afval_zet_lid(p_huishouden uuid, p_fostplus_id text, p_lid uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare o gezin.afval_ophalingen;
begin
  if not gezin.is_lid(p_huishouden) then raise exception 'Geen toegang tot dit gezin'; end if;
  select * into o from gezin.afval_ophalingen where huishouden_id = p_huishouden and fostplus_id = p_fostplus_id;
  if not found then raise exception 'Onbekende ophaling'; end if;
  if p_lid is not null and not exists (select 1 from gezin.leden where id = p_lid and huishouden_id = p_huishouden) then
    raise exception 'Dit gezinslid hoort niet bij dit gezin';
  end if;
  insert into gezin.afval_status (huishouden_id, fostplus_id, datum, fractie_id, lid_id)
  values (p_huishouden, p_fostplus_id, o.datum, o.fractie_id, p_lid)
  on conflict (huishouden_id, fostplus_id) do update
     set lid_id = excluded.lid_id, datum = excluded.datum, fractie_id = excluded.fractie_id, gewijzigd = now();
  delete from gezin.afval_status
   where huishouden_id = p_huishouden and fostplus_id = p_fostplus_id and lid_id is null and buitengezet_op is null;
end $$;

-- Afvinken: buitengezet (of terug ongedaan)
create function gezin.afval_vink(p_huishouden uuid, p_fostplus_id text, p_klaar boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare o gezin.afval_ophalingen;
begin
  if not gezin.is_lid(p_huishouden) then raise exception 'Geen toegang tot dit gezin'; end if;
  select * into o from gezin.afval_ophalingen where huishouden_id = p_huishouden and fostplus_id = p_fostplus_id;
  if not found then raise exception 'Onbekende ophaling'; end if;
  insert into gezin.afval_status (huishouden_id, fostplus_id, datum, fractie_id, buitengezet_op, buitengezet_door)
  values (p_huishouden, p_fostplus_id, o.datum, o.fractie_id,
          case when p_klaar then now() end, case when p_klaar then gezin.mijn_lid(p_huishouden) end)
  on conflict (huishouden_id, fostplus_id) do update
     set buitengezet_op = excluded.buitengezet_op, buitengezet_door = excluded.buitengezet_door,
         datum = excluded.datum, fractie_id = excluded.fractie_id, gewijzigd = now();
  delete from gezin.afval_status
   where huishouden_id = p_huishouden and fostplus_id = p_fostplus_id and lid_id is null and buitengezet_op is null;
  if p_klaar then perform gezin.log(p_huishouden, 'zette ' || o.fractie || ' buiten'); end if;
end $$;

revoke all on function gezin.afval_zet_verantwoordelijke(uuid, text, uuid), gezin.afval_zet_lid(uuid, text, uuid),
  gezin.afval_vink(uuid, text, boolean) from public, anon;
grant execute on function gezin.afval_zet_verantwoordelijke(uuid, text, uuid), gezin.afval_zet_lid(uuid, text, uuid),
  gezin.afval_vink(uuid, text, boolean) to authenticated;

-- ---------- Sync: ook de vervangdatum bewaren, oude status opruimen ------
create or replace function gezin.afval_sync(p_huishouden uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare a gezin.afval_adres; j jsonb; n integer;
begin
  select * into a from gezin.afval_adres where huishouden_id = p_huishouden;
  if not found then return 0; end if;
  j := gezin._fostplus(format(
    'collections?zipcodeId=%s&streetId=%s&houseNumber=%s&fromDate=%s&untilDate=%s&size=200',
    extensions.urlencode(a.zipcode_id), extensions.urlencode(a.street_id),
    extensions.urlencode(a.huisnummer), current_date, current_date + 84));
  delete from gezin.afval_ophalingen where huishouden_id = p_huishouden
     and (datum >= current_date or datum < current_date - 30);
  insert into gezin.afval_ophalingen (huishouden_id, fostplus_id, datum, fractie_id, fractie, kleur, logo, reden_wijziging, vervangt_datum)
  select p_huishouden, x->>'id', left(x->>'timestamp', 10)::date,
         x->'fraction'->>'id', x->'fraction'->'name'->>'nl', x->'fraction'->>'color',
         'https://assets.recycleapp.be/' || (x->'fraction'->'logo'->'regular'->>'2x'),
         x->'exception'->'reason'->'name'->>'nl',
         case when jsonb_typeof(x->'exception'->'replaces') = 'object'
              then left(x->'exception'->'replaces'->>'timestamp', 10)::date end
    from jsonb_array_elements(j->'items') x
   where x->'exception'->'replacedBy' is null
     and left(x->>'timestamp', 10)::date >= current_date
  on conflict (huishouden_id, fostplus_id) do update
     set datum = excluded.datum, fractie_id = excluded.fractie_id, fractie = excluded.fractie, kleur = excluded.kleur,
         logo = excluded.logo, reden_wijziging = excluded.reden_wijziging, vervangt_datum = excluded.vervangt_datum, opgehaald = now();
  get diagnostics n = row_count;
  delete from gezin.afval_status where huishouden_id = p_huishouden and datum < current_date - 60;
  update gezin.afval_adres set laatst_opgehaald = now(), laatste_status = 'ok: ' || n where huishouden_id = p_huishouden;
  return n;
end $$;
revoke all on function gezin.afval_sync(uuid) from public, anon, authenticated;

-- ---------- Realtime: de partner ziet afvinken en toewijzen meteen -------
alter publication supabase_realtime add table gezin.afval_status, gezin.afval_verantwoordelijke;

commit;
