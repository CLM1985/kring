# Kring – gezinsplatform

Eigen vervanger voor FamilyWall (en op termijn YNAB). Versie 12 + R5 · live sinds 11/11/2026.

**App:** https://clm1985.github.io/kring/ · **Database:** Supabase-project *Gezinsbudget*, schema `gezin` (schema `ynab` = YNAB-spiegel, enkel gelezen).

## Tabs
Aanmelden met een code uit de mail (geen link), zodat je de app nooit verlaat.

Vandaag · Agenda · Eten (weekmenu, gerechten, boodschappen/bestellijst, diepvries, voorraad) · Lijsten · **Energie** · Budget, plus **+** (snel toevoegen), Eilandraad (weekoverleg) en kindmodus.

## Bestanden
| Bestand | Inhoud |
|---|---|
| `index.html` | De volledige app in één bestand (geen build nodig voor GitHub Pages) |
| `config.js` | Supabase-URL + publishable key. Leeg = demomodus in de browser |
| `manifest.webmanifest`, `app/*.png`, `sw.js` | Installeerbaar als app (Android en iPhone), service worker: netwerk eerst, cache als reserve |
| `supabase/migrations/20261111_gezin_kring_basis.sql` | Volledig schema `gezin` met RLS (toegepast als migratie `gezin_kring_basis`) |
| `supabase/migrations/20261113_gezin_afval.sql` | Afvalkalender via Recycle! (Fost Plus): adres, ophalingen, nachtelijke sync (pg_cron) |
| `supabase/migrations/20261113_gezin_afval_toewijzing.sql` | Afval: vaste verantwoordelijke per soort, wie per ophaling, afvinken, vervangdatum, view `afval_agenda` |
| `supabase/migrations/20261113_gezin_taken_zichtbaar.sql` | Taken: "Zichtbaar voor" (RLS), geen log en geen ICS-export van afgeschermde taken |
| `supabase/migrations/20261122_gezin_barcodes.sql` | Barcodes (EAN/UPC) → product per gezin, voor **Tellen met scanner** (Voorraad en Diepvries; camera via BarcodeDetector in Chrome op Android) |
| `supabase/functions/recept-import` | Recept ophalen van een receptensite (JWT verplicht) |
| `supabase/functions/ics-ophalen` | Externe ICS-agenda ophalen (JWT verplicht) |
| `supabase/migrations/20261114_gezin_taak_duim.sql` | Duimpje omhoog/omlaag per taak (voorkomen), enkel voor ouders (beheerder, lid); tieners en kinderen zien niets |
| `supabase/migrations/20261114_gezin_energie.sql` | Energie: welk gezin bij de Home Assistant hoort, wie de laadmodus mag wijzigen (beheerder, lid), logboek |
| `supabase/migrations/20261115_gezin_wagens.sql` | Wagens op de energiepagina: naam in evcc, HA-sensoren voor batterij/bereik, foto (ouders wijzigen ze in de app) |
| `supabase/migrations/20261116_gezin_energie_dagprijs.sql` | Dagprijs-historiek (all-in, uit de publieke Frank-marktprijzen) voor de indeling goedkope / normale / dure dag; pg_cron vult elk uur aan |
| `supabase/migrations/20261119_gezin_energie_dagkost.sql` | Kost per dag van de stroom (kWh afname/injectie en Σ kWh × marktprijs per dag, maandpiek); gevuld door `ha-energie`, leesbaar voor elk gezinslid |
| `supabase/functions/ha-energie` | Energiepagina: evcc lezen en laadmodus Uit/Slim/Snel zetten via Home Assistant (JWT verplicht; HA-token enkel als geheim) |
| `supabase/functions/ha-apparaten` | Energiepagina: kWh per kwartier per apparaat uit het energiedashboard van HA (Individuele apparaten), voor *Per apparaat* en *Waar ging de stroom naartoe?* (JWT zelf gecontroleerd; deploy met `--no-verify-jwt`) |
| `supabase/functions/agenda-feed` | Kring-agenda als ICS-feed voor Google/iPhone (zonder JWT, geheime token) |

De vroegere losse bronbestanden (`src/*.js`, `build.js`) en de 4 migraties van 8/11 zijn vervangen; ze staan nog in de git-historiek.

## Privacy
Geen persoonlijke data in deze publieke repo: geen recepten, producten, tickets of budgetcijfers. De demomodus gebruikt fictieve namen (Ouder A, Ouder B, Kind). `data/`, `*seed*.json` en `.env` staan in `.gitignore`.

## Beveiliging
- Elke tabel heeft RLS per huishouden; `anon` heeft geen rechten op schema `gezin`.
- Pincodes (bcrypt) en Google-tokens (Supabase Vault) zijn niet leesbaar voor de app.
- Zet in Supabase *Allow new users to sign up* uit zodra de gezinsaccounts bestaan.

## Terugdraaien (zolang er geen echte data is)
1. Supabase → Data API → `gezin` uit de exposed schemas halen.
2. SQL: `drop schema gezin cascade;`

## Energie (evcc via Home Assistant)
- **Pad:** app → Edge Function `ha-energie` → HA (Nabu Casa) → `rest_command` → evcc (`127.0.0.1:7070`). De app kent het HA-token niet.
- **Geheimen** (Supabase → Edge Functions → Secrets): `HA_URL` (zonder `/` op het einde) en `HA_TOKEN` (langdurig token "Kring" in HA).
- **In HA, `configuration.yaml`:**
  ```yaml
  rest_command:
    kring_evcc_state:
      url: "http://127.0.0.1:7070/api/state"
      method: get
      timeout: 10
    kring_evcc_mode:
      url: "http://127.0.0.1:7070/api/loadpoints/1/mode/{{ mode if mode in ['off','smart','now'] else 'smart' }}"
      method: post
      timeout: 10
  ```
- **Wagen apart:** REST-sensor `sensor.wagen_laadvermogen` (W, uit evcc `/api/state`, elke 30 s) in `configuration.yaml`:
  ```yaml
  rest:
    - resource: "http://127.0.0.1:7070/api/state"
      scan_interval: 30
      sensor:
        - name: "Wagen laadvermogen"
          unique_id: kring_wagen_laadvermogen
          value_template: "{{ ((value_json.result | default(value_json)).loadpoints[0].chargePower | float(0)) | round(0) }}"
          unit_of_measurement: "W"
          device_class: power
          state_class: measurement
  ```
  Plus de helper *Wagen laadenergie* (integraal, kWh) voor het energiedashboard van HA. Gemeten vanaf 14/11/2026.
- **Laadstroom (A):** derde rest_command in HA (toegevoegd op 15/11/2026, herladen met `rest_command.reload`):
  ```yaml
    kring_evcc_maxcurrent:
      url: "http://127.0.0.1:7070/api/loadpoints/1/maxcurrent/{{ (ampere | int) if (ampere | int) in [6, 8, 10, 13, 16] else 16 }}"
      method: post
      timeout: 10
  ```
- **Minimale laadstroom** (6/8/10/13 A, geldt voor Altijd laden): `rest_command.kring_evcc_mincurrent` → `POST /api/loadpoints/1/mincurrent/{A}`.
- **Altijd laden** (Slim met minstens het minimum): `rest_command.kring_evcc_alwayscharge` → `POST /api/loadpoints/1/alwayscharge/{on|off|once}` (toegevoegd op 15/11/2026).
- **Laadvenster:** tabel `gezin.laadvenster`; pg_cron-job `laadvenster` (elke minuut) roept bij een overgang `ha-energie` aan met `actie: "tick"` en het token uit `gezin.laadvenster_tick`. Daarom draait `ha-energie` zonder JWT-controle aan de poort (`--no-verify-jwt`); de functie controleert zelf.
  Buiten het venster kijkt de bewaking om de 5 minuten of evcc op Uit staat en zet het anders terug (logregel `bewaking`). Bewust laden buiten het venster: knop **Toch laden** (1, 2, 4, 8 of 12 u, of tot het venster begint), opgeslagen in `uitzondering_tot`.
- **Toegang:** lezen voor elk lid van het gezin in `gezin.energie_koppeling`; de laadmodus wijzigen enkel voor beheerder en lid. Elke wijziging staat in `gezin.energie_log`.
- **Kost per dag:** blok *Kost per dag* op de Energie-tab (voor iedereen in het gezin). `ha-energie` leest elk uur (pg_cron `energie-dagprijzen`, actie `dagprijzen`) de netmeters van het energiedashboard uit de HA-statistieken: 5-minutenwaarden voor de laatste 8 dagen, uurwaarden daarvoor (sinds 1/8/2026, 40 dagen per ronde), en weegt elk kwartier met de Frank-marktprijs. In `gezin.energie_dagkost` staan enkel kWh en Σ kWh × marktprijs; de euro's volgen bij het lezen (actie `dagkost`) uit de constanten in `ha-energie` (`FACTOR`, `VAST`, `TOESLAG`, `INJ_FACTOR`, `INJ_VAST`, `VASTE_KOST_DAG`, `CAP_KW_JAAR`). Een aangepaste formule geldt zo voor de hele historiek. De maandpiek komt enkel uit dagen met kwartierwaarden; de meter van Fluvius blijft de referentie.
- **Maandverloop:** onder *Kost per dag*: de netto kost per dag (actie `dagkost`, nu met `dagen: 92`) opgeteld per maand, en dezelfde na de laadvergoeding van EVC-net (RPC `gezin.laadvergoeding_per_dag(p_van, p_tot)` → `[{dag, eur, kwh, sessies}]`). Bladeren kan naar de maanden die volledig binnen die 92 dagen vallen; referentie = totaal van de vorige maand, prognose pas vanaf 7 gemeten dagen.
- **Grafiektaal (23/11/2026):** alle grafieken gebruiken dezelfde kaartopbouw (kerncijfers, uitleesregel bij tikken/slepen, legende, *Tabel en berekening*) en één kleurset `--g-*` (net, zon, wagen, goedkoop/normaal/duur uur), licht en donker. *Waar ging de stroom naartoe?* is geen Sankey meer maar een bronbalk + gerangschikte lijst.
- **Advies per toestel:** programmaprofielen gemeten met de meetstekkers (4–14/11/2026), kwartierprijzen en injectie uit evcc (Frank), zonneverwachting uit evcc. Rekenregels in `KringEnergie` (index.html).

## Laadregels per wagen (sinds 22/11/2026)
- **Herkenning:** `laadpaal-bewaking` (pg_cron elke 5 min) leest de laadkaart op de laadpaal (EVC-net) en bewaart de wagen per sessie in `gezin.laadsessie_wagen`.
- **Regel per wagen** in `gezin.wagens` (`regel_actief`, `regel_modus`, `plan_tijd`, `plan_kwh`, venster, blok 17–21, weekend overdag, `capaciteit_kwh`).
- **Laadplan:** `gezin.laadplan(wagen)` verdeelt wat nog nodig is over de kwartieren tot het doeluur: eerst verwachte zon (`gezin.zon_forecast`, Forecast.Solar via evcc), dan de goedkoopste kwartieren (`gezin.prijs_forecast`, evcc). Laadpas CLM: alles binnen 11 u 40 (bezettingsvergoeding).
- **Sturing:** `laadpaal-bewaking` zet evcc per kwartier op Snel (gepland kwartier), Slim (zonoverschot) of Uit, met Altijd laden uit. Log in `gezin.laadbewaking_log` (actie `sturing`).
- **Twee keuzes in Kring:** *volgens plan* (standaard) of *Regels overrulen tot uitpluggen*: Nu laden, Alleen zon of Niet laden (actie `regels`). Een wijziging in evcc zelf telt ook als overrule. *Plan hervatten* geeft de controle terug.
- **Doel per sessie:** ✏️ *Doel aanpassen* op de wagenkaart (klaar om, kWh), geldt tot uitpluggen (actie `doel`).
- **Onbekende kaart:** standaardregel (`gezin.wagens.standaard`): zonoverschot en de goedkoopste nachtkwartieren, 10 kWh tegen 07:00.
- **Laadvenster en modusknoppen:** niet meer op de Energie-pagina (venster uitgezet op 22/11/2026). Laadstroom (min/max) staat bij Instellingen → Laadpaal (technisch).
- **Verwachting in Kring:** de wagenkaart toont het verwachte laadniveau op het doeluur (batterij% uit evcc of de HA-sensor), zon/net, kost en wanneer klaar.
