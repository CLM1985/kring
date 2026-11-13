-- =====================================================================
-- Kring – taken: "Zichtbaar voor" (een of meer gezinsleden, of iedereen)
-- Versie 1 · 13/11/2026
--
-- zichtbaar_voor = null    → iedereen van het gezin (ook bestaande taken)
-- zichtbaar_voor = {a, b}  → enkel die leden, plus wie de taak doet en wie eraan denkt
-- Een lege lijst kan niet. De app verplicht een keuze bij elke nieuwe taak.
-- =====================================================================

begin;

alter table gezin.taken add column zichtbaar_voor uuid[]
  check (zichtbaar_voor is null or cardinality(zichtbaar_voor) > 0);

-- Mag de aangemelde gebruiker deze taak zien?
create function gezin.ziet_taak(p_huishouden uuid, p_zichtbaar uuid[], p_lid uuid, p_eigenaar uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select gezin.is_lid(p_huishouden)
     and (p_zichtbaar is null
          or (select gezin.mijn_lid(p_huishouden)) = any(p_zichtbaar)
          or (select gezin.mijn_lid(p_huishouden)) in (p_lid, p_eigenaar));
$$;
revoke all on function gezin.ziet_taak(uuid, uuid[], uuid, uuid) from public, anon;
grant execute on function gezin.ziet_taak(uuid, uuid[], uuid, uuid) to authenticated;

-- Geldige leden: alles in zichtbaar_voor hoort bij hetzelfde gezin
create function gezin.leden_van_gezin(p_huishouden uuid, p_leden uuid[])
returns boolean language sql stable security definer set search_path = '' as $$
  select p_leden is null or not exists (
    select 1 from unnest(p_leden) z
     where not exists (select 1 from gezin.leden l where l.id = z and l.huishouden_id = p_huishouden));
$$;
revoke all on function gezin.leden_van_gezin(uuid, uuid[]) from public, anon;
grant execute on function gezin.leden_van_gezin(uuid, uuid[]) to authenticated;

drop policy taken_rw on gezin.taken;
create policy taken_lezen on gezin.taken for select to authenticated
  using (gezin.ziet_taak(huishouden_id, zichtbaar_voor, lid_id, eigenaar_id));
create policy taken_nieuw on gezin.taken for insert to authenticated
  with check (gezin.is_lid(huishouden_id)
    and (lid_id is null or exists (select 1 from gezin.leden l where l.id = taken.lid_id and l.huishouden_id = taken.huishouden_id))
    and (eigenaar_id is null or exists (select 1 from gezin.leden l where l.id = taken.eigenaar_id and l.huishouden_id = taken.huishouden_id))
    and gezin.leden_van_gezin(huishouden_id, zichtbaar_voor)
    and gezin.ziet_taak(huishouden_id, zichtbaar_voor, lid_id, eigenaar_id));   -- wie bewaart, moet de taak nog zien
create policy taken_wijzigen on gezin.taken for update to authenticated
  using (gezin.ziet_taak(huishouden_id, zichtbaar_voor, lid_id, eigenaar_id))
  with check (gezin.is_lid(huishouden_id)
    and (lid_id is null or exists (select 1 from gezin.leden l where l.id = taken.lid_id and l.huishouden_id = taken.huishouden_id))
    and (eigenaar_id is null or exists (select 1 from gezin.leden l where l.id = taken.eigenaar_id and l.huishouden_id = taken.huishouden_id))
    and gezin.leden_van_gezin(huishouden_id, zichtbaar_voor)
    and gezin.ziet_taak(huishouden_id, zichtbaar_voor, lid_id, eigenaar_id));
create policy taken_wissen on gezin.taken for delete to authenticated
  using (gezin.ziet_taak(huishouden_id, zichtbaar_voor, lid_id, eigenaar_id));

-- Afvinken: enkel taken die je ziet (de subquery valt onder de RLS van taken)
drop policy taak_klaar_rw on gezin.taak_klaar;
create policy taak_klaar_rw on gezin.taak_klaar for all to authenticated
  using (gezin.is_lid(huishouden_id)
    and exists (select 1 from gezin.taken t where t.id = taak_klaar.taak_id))
  with check (gezin.is_lid(huishouden_id)
    and exists (select 1 from gezin.taken t where t.id = taak_klaar.taak_id and t.huishouden_id = taak_klaar.huishouden_id)
    and (door_lid is null or exists (select 1 from gezin.leden l where l.id = taak_klaar.door_lid and l.huishouden_id = taak_klaar.huishouden_id)));

-- Activiteit: afvinken van een afgeschermde taak niet loggen (iedereen leest de activiteit)
do $do$
declare d text; zoek text := E'elsif tg_table_name = ''taak_klaar'' then\n';
begin
  d := pg_get_functiondef('gezin.log_trigger()'::regprocedure);
  if position(zoek in d) = 0 then raise exception 'log_trigger: taak_klaar-tak niet gevonden'; end if;
  d := replace(d, zoek, zoek || E'    if (select zichtbaar_voor from gezin.taken where id = new.taak_id) is not null then return new; end if;\n');
  execute d;
end
$do$;

commit;
