-- Kring: duimpje omhoog of omlaag per gedane (of niet gedane) taak, gegeven door een ouder.
-- Enkel ouders (rol beheerder of lid) zien en geven duimpjes; tieners en kinderen niet (ook niet via de API).
-- Bedoeld voor de terugblik in de Eilandraad. Geen activiteitslog: kinderen lezen de activiteit.

create function gezin.is_ouder(p_huishouden uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from gezin.leden
                  where huishouden_id = p_huishouden and user_id = (select auth.uid())
                    and rol in ('beheerder', 'lid'));
$$;
revoke all on function gezin.is_ouder(uuid) from public, anon;
grant execute on function gezin.is_ouder(uuid) to authenticated;

create table gezin.taak_duim (
  taak_id       uuid not null references gezin.taken on delete cascade,
  datum         date not null,                       -- het voorkomen van de taak
  huishouden_id uuid not null references gezin.huishoudens on delete cascade,
  duim          smallint not null check (duim in (-1, 1)),
  door          uuid not null default auth.uid(),
  op            timestamptz not null default now(),
  primary key (taak_id, datum)
);
create index on gezin.taak_duim (huishouden_id, datum);
alter table gezin.taak_duim enable row level security;

-- Enkel ouders, en enkel voor taken die ze zelf mogen zien (de subquery valt onder de RLS van taken)
create policy taak_duim_ouders on gezin.taak_duim for all to authenticated
  using (gezin.is_ouder(huishouden_id) and exists (select 1 from gezin.taken t where t.id = taak_duim.taak_id))
  with check (gezin.is_ouder(huishouden_id)
    and exists (select 1 from gezin.taken t where t.id = taak_duim.taak_id and t.huishouden_id = taak_duim.huishouden_id)
    and door = (select auth.uid()));

revoke all on gezin.taak_duim from public, anon;
grant select, insert, update, delete on gezin.taak_duim to authenticated;
