-- Kring – afvalkalender via de publieke Recycle!-API (Fost Plus). Zoals uitgevoerd op 13/11/2026.
-- Het adres staat niet in deze repo: dat stel je in via gezin.afval_stel_adres.

create extension if not exists http with schema extensions;
create extension if not exists pg_cron;

create table gezin.afval_adres (
  huishouden_id uuid primary key references gezin.huishoudens(id) on delete cascade,
  postcode text not null, straat text not null, huisnummer text not null,
  zipcode_id text not null, street_id text not null,
  laatst_opgehaald timestamptz, laatste_status text,
  gewijzigd timestamptz not null default now());

create table gezin.afval_ophalingen (
  huishouden_id uuid not null references gezin.huishoudens(id) on delete cascade,
  fostplus_id text not null, datum date not null,
  fractie_id text, fractie text not null, kleur text, logo text, reden_wijziging text,
  opgehaald timestamptz not null default now(),
  primary key (huishouden_id, fostplus_id));
create index afval_ophalingen_datum on gezin.afval_ophalingen (huishouden_id, datum);

alter table gezin.afval_adres enable row level security;
alter table gezin.afval_ophalingen enable row level security;
create policy afval_adres_lezen on gezin.afval_adres for select to authenticated using (gezin.is_lid(huishouden_id));
create policy afval_ophalingen_lezen on gezin.afval_ophalingen for select to authenticated using (gezin.is_lid(huishouden_id));
grant select on gezin.afval_adres, gezin.afval_ophalingen to authenticated;

create or replace function gezin._fostplus(p_pad text, p_methode text default 'GET')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r extensions.http_response;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '20');
  select * into r from extensions.http((
    p_methode, 'https://api.fostplus.be/recyclecms/public/v1/' || p_pad,
    array[extensions.http_header('x-consumer','recycleapp.be'),
          extensions.http_header('User-Agent','Kring-gezinsapp/1.0 (1x per dag)')],
    case when p_methode = 'POST' then 'application/json' end,
    case when p_methode = 'POST' then '' end)::extensions.http_request);
  if r.status <> 200 then raise exception 'Fost Plus % % gaf HTTP %', p_methode, p_pad, r.status; end if;
  return r.content::jsonb;
end $$;

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
  insert into gezin.afval_ophalingen (huishouden_id, fostplus_id, datum, fractie_id, fractie, kleur, logo, reden_wijziging)
  select p_huishouden, x->>'id', left(x->>'timestamp',10)::date,
         x->'fraction'->>'id', x->'fraction'->'name'->>'nl', x->'fraction'->>'color',
         'https://assets.recycleapp.be/' || (x->'fraction'->'logo'->'regular'->>'2x'),
         x->'exception'->'reason'->'name'->>'nl'
    from jsonb_array_elements(j->'items') x
   where x->'exception'->'replacedBy' is null
     and left(x->>'timestamp',10)::date >= current_date
  on conflict (huishouden_id, fostplus_id) do update
     set datum = excluded.datum, fractie = excluded.fractie, kleur = excluded.kleur,
         logo = excluded.logo, reden_wijziging = excluded.reden_wijziging, opgehaald = now();
  get diagnostics n = row_count;
  update gezin.afval_adres set laatst_opgehaald = now(), laatste_status = 'ok: ' || n where huishouden_id = p_huishouden;
  return n;
end $$;

create or replace function gezin.afval_sync_alle()
returns void language plpgsql security definer set search_path = '' as $$
declare h uuid;
begin
  for h in select huishouden_id from gezin.afval_adres loop
    begin perform gezin.afval_sync(h);
    exception when others then
      update gezin.afval_adres set laatste_status = 'fout: ' || sqlerrm where huishouden_id = h;
    end;
  end loop;
end $$;

create or replace function gezin.afval_stel_adres(p_huishouden uuid, p_postcode text, p_straat text, p_huisnummer text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j jsonb; v_zip text; v_street text; v_naam text; v_kand jsonb; n integer;
begin
  if not gezin.is_lid(p_huishouden) then raise exception 'Geen lid van dit huishouden'; end if;
  j := gezin._fostplus('zipcodes?q=' || extensions.urlencode(trim(p_postcode)));
  select x->>'id' into v_zip from jsonb_array_elements(j->'items') x where x->>'code' = trim(p_postcode) limit 1;
  if v_zip is null then raise exception 'Postcode % niet gevonden bij Recycle!', p_postcode; end if;
  j := gezin._fostplus(format('streets?q=%s&zipcodes=%s', extensions.urlencode(trim(p_straat)), extensions.urlencode(v_zip)), 'POST');
  select x->>'id', x->'names'->>'nl' into v_street, v_naam from jsonb_array_elements(j->'items') x
   where lower(x->'names'->>'nl') = lower(trim(p_straat)) limit 1;
  if v_street is null and jsonb_array_length(j->'items') = 1 then
    v_street := j->'items'->0->>'id'; v_naam := j->'items'->0->'names'->>'nl';
  end if;
  if v_street is null then
    select coalesce(jsonb_agg(x->'names'->>'nl'), '[]') into v_kand from jsonb_array_elements(j->'items') x;
    raise exception 'Straat "%" niet eenduidig. Kandidaten: %', p_straat, v_kand;
  end if;
  insert into gezin.afval_adres (huishouden_id, postcode, straat, huisnummer, zipcode_id, street_id)
  values (p_huishouden, trim(p_postcode), v_naam, trim(p_huisnummer), v_zip, v_street)
  on conflict (huishouden_id) do update set postcode = excluded.postcode, straat = excluded.straat,
    huisnummer = excluded.huisnummer, zipcode_id = excluded.zipcode_id, street_id = excluded.street_id, gewijzigd = now();
  n := gezin.afval_sync(p_huishouden);
  return jsonb_build_object('straat', v_naam, 'zipcode_id', v_zip, 'street_id', v_street, 'ophalingen', n);
end $$;

revoke all on function gezin._fostplus(text, text), gezin.afval_sync(uuid), gezin.afval_sync_alle() from public, anon, authenticated;
revoke all on function gezin.afval_stel_adres(uuid, text, text, text) from public, anon;
grant execute on function gezin.afval_stel_adres(uuid, text, text, text) to authenticated;

select cron.schedule('afval-fostplus-sync', '17 3 * * *', $$select gezin.afval_sync_alle()$$);
