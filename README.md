# Kring – R1 t/m R4 (testversie)

Versie 4 · 8/11/2026 · testversie, nog niets uitgevoerd op Supabase

Tabs: **Vandaag · Agenda · Eten** (weekmenu, gerechten, boodschappen) **· Lijsten · Budget**, plus de knop **+** (snel toevoegen) op elk scherm.

## R4 Budget lezen

| Onderdeel | Functie |
|---|---|
| **Plan** | Per maand: te verdelen (groen/rood), groepen met toegewezen / activiteit / beschikbaar, doelen met voortgangsbalk, filters (te weinig, overbesteed, geld beschikbaar). Detailpaneel per categorie: overgedragen + toegewezen + activiteit, doel, gemiddelde uitgaven 3 en 12 maanden, laatste transacties. |
| **Rekeningen** | Budget- en opvolgrekeningen met saldo en "nog niet verwerkt"; register per rekening met lopend saldo en zoeken. |
| **Rapporten** | Uitgaven per categorie in een maand, uitgaven per maand (12 mnd), inkomen tegenover uitgaven met cijfertabel. |
| **Controle** | Vergelijkt de eigen berekening met de YNAB-cijfers (in de echte versie bij elke keer openen). |

Rekenregels (`src/budget.js`), gevalideerd op de YNAB-spiegel, gezamenlijk plan, jan 2018 – nov 2026:

| Controle | Resultaat |
|---|---|
| Activiteit per categorie per maand (transacties + splitsingen) | 14.873 / 14.873 op de cent |
| Beschikbaar = max(vorige, 0) + toegewezen + activiteit | 14.873 / 14.873 |
| Toegewezen en activiteit per maand (totaal) | 107 / 107 |
| Te verdelen per maand | 106 / 107 – afwijking € 331,05 in nov 2026, kredietkaartlogica, nog uit te zoeken |

Te verdelen = Σ inkomen − Σ toegewezen (incl. kredietkaartbetaling) + Σ overbesteding t/m vorige maand; getoond als max(0, A − later toegewezen) als A ≥ 0.

De testversie gebruikt een **fictief** budget. Echte cijfers komen pas in de echte versie, achter login: `gezin.budget_gegevens` levert de laatste 24 maanden uit de spiegel (beginsaldi + transacties + toewijzingen + YNAB-cijfers ter controle), enkel voor het plan in `gezin.budget_bron`.

## R3 Gezin

| Onderdeel | Functie |
|---|---|
| **Vandaag** | Vandaag in de agenda (ook te laat), vanavond eten, boodschappen + geraamde kost, budget (te verdelen, boodschappen, overbesteed), jouw to-do's, verjaardagen, recente activiteit. |
| **Lijsten** | Vastgezet: boodschappen van de week + To Do. Vrije lijsten (to-do, lijst, boodschappen), gedeeld of privé. Items met wie en deadline; met deadline komen ze in de agenda. "zaterdag" in de tekst wordt de deadline. |
| **Activiteit** | Wie deed wat (afvinken, plannen, toevoegen); in de echte versie via triggers, privélijsten niet. |
| **Snel toevoegen (+)** | "morgen 19u30 tandarts" → afspraak, "vrijdag ramen wassen" → taak, "melk" → boodschappen. Soort aanpasbaar. |
| **Google Agenda** | Stap 1: Edge Function `agenda-feed` (geheime ICS-link, Kring → Google). Google → Kring via ICS-abonnement (R2). Echte tweerichting (bewerken in Google) via Google API: later. |
| **Pushmeldingen** | Nog niet: kan via Home Assistant (melding naar de Companion-app) of web push. Keuze bij livegang. |

Getest: migratie `20261108_gezin_lijsten.sql` en `20261108_gezin_budget_lezen.sql` op lokale Postgres (privélijst niet zichtbaar en niet gelogd, ander gezin geweigerd, budgetfunctie levert 48/48 controlewaarden op testdata); browser gsm en desktop zonder fouten.

---

# R1 Maaltijden + R2 Agenda

## R2 Agenda

| Onderdeel | Functie |
|---|---|
| **Agenda** (eerste tab) | Week- en maandweergave. Agenda's met kleur (Gezin, per ouder, eigen agenda's), aan/uit per agenda. Ingebouwd: taken, verjaardagen, maaltijden uit het weekmenu, Belgische feestdagen, Vlaamse schoolvakanties. |
| **Afspraken** | Titel, agenda, hele dag of tijd, meerdere dagen, plaats, wie, notitie, herinnering (bewaard; melding in de echte versie). Herhaling: elke dag / week (weekdagen kiezen) / 2 weken / maand / jaar, tot en met. Eén keer schrappen of hele reeks verwijderen. |
| **Taken met deadline** | Op hun datum in de agenda, met afvinken per keer (ook herhalend: afval buitenzetten). Te laat: eenmalige taken van de voorbije 30 dagen en het laatst gemiste keer van herhalende taken. |
| **Verjaardagen** | Jaarlijks, met leeftijd als het jaar gekend is; komende 14 dagen bovenaan. |
| **Externe agenda's** | ICS-bestand importeren (testversie). Abonneren op een link (school, sportclub) via Edge Function `ics-ophalen` in de echte versie. |
| **Agenda naast weekmenu** | Elke dag in het weekmenu toont de afspraken en taken; ook in het kiesvenster. |
| **Gezinsleden** | Leden met kleur, ook zonder account (kinderen). |

Bronnen: schoolvakanties Vlaanderen 2025-2026 en 2026-2027 van vlaanderen.be (opgehaald 8/11/2026), elk jaar aanvullen in `src/agenda.js`. Feestdagen worden berekend (Pasen volgens Meeus).

Getest: herhalingslogica, feestdagen, ICS-lezer (Node); migratie `20261108_gezin_agenda.sql` op lokale Postgres (ander gezin ziet niets, kan niet afvinken); browser op gsm en desktop.

Nog niet in R2: herinneringen als pushmelding, Google Agenda in twee richtingen (R3), "alleen deze keer wijzigen" bij een reeks (nu: schrappen of hele reeks), echte FamilyWall-agenda overzetten.

---

## R1 Maaltijden


## Wat zit erin

| Scherm | Functie |
|---|---|
| **Weekmenu** | Maandag–zondag, maaltijdmomenten ontbijt / middag / snack / avond (kiezen via ⋯). Per moment een gerecht met aantal personen, of vrije tekst. Op een breed scherm: receptenpaneel rechts, recept slepen naar een dag, dag slepen naar een andere dag (wisselt). |
| **Gerechten** | 141 recepten uit FamilyWall. Zoeken op naam of ingrediënt, categorieën, filter "Zonder ingrediënten" (15). Recept bekijken en meteen inplannen. Bewerken met "Lijst plakken" (tekstregels → hoeveelheid, eenheid, naam) en "Ophalen" van een receptensite (enkel in de echte versie). |
| **Boodschappen** | Uit het weekmenu: herschaald naar het aantal personen, samengeteld per ingrediënt en eenheid, per winkelafdeling. Per item het gekoppelde Collect&Go-product met aantal verpakkingen, prijs en zoeklink. Geraamde kost bovenaan. Basisvoorraad (zout, olie, boter …) apart onder "Voorraadkast nakijken". |
| **Koppelen** | Eén koppeling per ingrediëntnaam, geldt voor alle recepten. Voorstel uit jullie 198 eerder gekochte voedingsproducten; bevestigen, zelf zoeken of "geen product". "Producten koppelen" loopt alle open items na elkaar af. |

### Migratie FamilyWall (eenmalig, 8/11/2026)
- 141 recepten, waarvan 126 met ingrediënten (1.375 regels, 74 % met hoeveelheid).
- Ingrediënten waren vrije tekst; `src/ingredient.js` leest ze om (ook "600g kabeljauw", "erwten (diepvries) 400 g", "½ rode ui", "0, 6 l", "1.000 g").
- Porties ontbreken bij een deel van de recepten → standaard 4. Kijk dit na bij recepten die je vaak maakt.
- Bereidingsinstructies zijn niet meegenomen (enkel naam, tijd, porties, bron, ingrediënten).

### Rekenregels boodschappenlijst
- Hoeveelheid × (personen in weekmenu ÷ personen van het recept).
- Samentellen op ingrediënt (synoniemen: look = knoflook, ajuin = ui, …) en basiseenheid: `g/kg → g`, `ml/cl/dl/l → ml`.
- Verpakkingen = benodigde hoeveelheid ÷ inhoud, naar boven afgerond. Losse producten per kg: hoeveelheid × kg-prijs.
- Stuks ↔ gram (bv. "9 ui" en "Uien per kg") rekent nog niet om: dan staat er enkel het product, zonder aantal of prijs.
- Prijzen = Collect&Go-prijs van 7/11/2026, zonder promoties.

## Bestanden

| Bestand | Inhoud |
|---|---|
| `index.html` | De app (geen build nodig voor GitHub Pages) |
| `src/ingredient.js` | Ingrediënten lezen, eenheden, afdelingen, productvoorstellen |
| `config.js` | Supabase-URL + publishable key; leeg = testversie |
| `../kring-prive/` (niet in de repo) | Persoonlijke data: FamilyWall-recepten, Collect&Go-aankopen, omzetscripts en `kring-seed.json` voor de import |
| `supabase/migrations/20261107_gezin_menu.sql` | Schema `gezin` v2 met RLS, import-RPC's en realtime |
| `supabase/functions/recept-import/` | Edge Function: recept ophalen van een receptensite (JSON-LD) |
| `src/agenda.js`, `src/agenda-ui.js` | Agendalogica (herhaling, feestdagen, schoolvakanties, ICS) en agenda-scherm |
| `supabase/migrations/20261108_gezin_agenda.sql` | R2: agenda's, afspraken, taken, verjaardagen |
| `supabase/functions/ics-ophalen/` | Edge Function: externe ICS-agenda ophalen |
| `src/budget.js`, `src/budget-ui.js` | R4: rekenmotor, testbudget, budgetscherm |
| `src/gezin-ui.js` | R3: Vandaag, lijsten, snel toevoegen, activiteit |
| `supabase/migrations/20261108_gezin_lijsten.sql` | R3: lijsten, activiteit, agenda-feed |
| `supabase/migrations/20261108_gezin_budget_lezen.sql` | R4: budgetgegevens uit de YNAB-spiegel |
| `supabase/functions/agenda-feed/` | Edge Function: Kring-agenda als ICS voor Google Agenda |
| `build.js` → `dist/kring-test.html` | Testversie in één bestand |

## Testen gebeurd (8/11/2026)
- Migratiescript op een lokale Postgres 16: schema aangemaakt, import 141 recepten / 1.375 ingrediënten / 198 producten, tweede import 0 (idempotent), ander gezin ziet niets, `anon` geweigerd.
- Browser (Playwright): weekmenu, slepen-paneel, boodschappenlijst met producten, koppelen, recept plakken, gsm-breedte zonder horizontaal scrollen.

## Naar de echte versie (na akkoord)
1. **Branch** van Gezinsbudget aanmaken, script uitvoeren, Edge Function deployen, testen met de site tegen de branch.
2. Dashboard: e-maillogin aan, redirect-URL = Pages-URL, schema `gezin` openzetten in de Data API (`ynab` niet).
3. Na akkoord: script op de echte database, branch verwijderen.
4. GitHub-repo `kring`, Pages aanzetten, `config.js` invullen.
5. In de app: ⋯ → "Recepten en producten importeren" en `kring-seed.json` kiezen (staat niet in de repo).

## Open punten
| Item | Toelichting |
|---|---|
| Offline afvinken | Service worker voor de lijst in de winkel (volgt bij livegang) |
| Stuks ↔ gram | Omrekening per ingrediënt (1 ui ≈ 150 g) voor prijs en aantal |
| Agenda naast weekmenu | Komt met R2 Agenda |
| Producten toevoegen | Nieuw Collect&Go-product toevoegen aan de lijst (nu enkel eerder gekochte) |
| Bereiding uit FamilyWall | Eventueel later meenemen |
