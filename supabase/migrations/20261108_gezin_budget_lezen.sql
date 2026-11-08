-- =====================================================================
-- Kring – R4 Budget lezen: gegevens uit de YNAB-spiegel (schema ynab) voor de rekenmotor in de app
-- Versie 1 · 8/11/2026 (nog niet uitgevoerd; eerst op een branch)
--
-- Leest enkel uit schema ynab (geen wijzigingen, geen afhankelijkheid van ynab-views).
-- Enkel het plan dat aan het gezin gekoppeld is (gezamenlijk plan); persoonlijke plannen blijven onzichtbaar.
-- De rekenregels zijn gevalideerd op de spiegel (8/11/2026): activiteit en beschikbaar 14.873/14.873,
-- te verdelen 106/107 maanden (afwijking in de kredietkaartlogica, nog uit te zoeken).
-- =====================================================================

begin;

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

commit;

-- Na uitvoeren, eenmalig (beheerder, SQL Editor):
-- insert into gezin.budget_bron (huishouden_id, plan_id)
-- select h.id, p.plan_id from gezin.huishoudens h, ynab.plan p where h.naam = '<naam gezin>' and p.name = 'Gezamelijke';
