-- Kring: barcodes (EAN/UPC) koppelen aan producten, voor tellen met de gsm-camera.
-- De app leert de koppeling: een onbekende barcode koppel je één keer aan een product, daarna wordt hij herkend.
-- Gewichtsartikelen (EAN-13 die met 2 begint) worden in de app ingekort tot de eerste 7 cijfers.

create table gezin.product_barcodes (
  huishouden_id uuid not null references gezin.huishoudens on delete cascade,
  code          text not null check (code ~ '^[0-9]{7,14}$'),
  product_id    uuid not null references gezin.producten on delete cascade,
  eenheid       text not null default 'stuk' check (eenheid in ('stuk', 'kg', 'pak', 'fles', 'blik')),
  toegevoegd    timestamptz not null default now(),
  door          uuid default auth.uid(),
  primary key (huishouden_id, code)
);
create index on gezin.product_barcodes (product_id);

alter table gezin.product_barcodes enable row level security;

create policy barcodes_rw on gezin.product_barcodes for all to authenticated
  using (gezin.is_lid(huishouden_id))
  with check (gezin.is_lid(huishouden_id)
    and exists (select 1 from gezin.producten p where p.id = product_id and p.huishouden_id = product_barcodes.huishouden_id));

revoke all on gezin.product_barcodes from public, anon;
grant select, insert, update, delete on gezin.product_barcodes to authenticated;
