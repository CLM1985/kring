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
| `supabase/functions/recept-import` | Recept ophalen van een receptensite (JWT verplicht) |
| `supabase/functions/ics-ophalen` | Externe ICS-agenda ophalen (JWT verplicht) |
| `supabase/migrations/20261114_gezin_taak_duim.sql` | Duimpje omhoog/omlaag per taak (voorkomen), enkel voor ouders (beheerder, lid); tieners en kinderen zien niets |
| `supabase/migrations/20261114_gezin_energie.sql` | Energie: welk gezin bij de Home Assistant hoort, wie de laadmodus mag wijzigen (beheerder, lid), logboek |
| `supabase/functions/ha-energie` | Energiepagina: evcc lezen en laadmodus Uit/Slim/Snel zetten via Home Assistant (JWT verplicht; HA-token enkel als geheim) |
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
- **Toegang:** lezen voor elk lid van het gezin in `gezin.energie_koppeling`; de laadmodus wijzigen enkel voor beheerder en lid. Elke wijziging staat in `gezin.energie_log`.
- **Advies per toestel:** programmaprofielen gemeten met de meetstekkers (4–14/11/2026), kwartierprijzen en injectie uit evcc (Frank), zonneverwachting uit evcc. Rekenregels in `KringEnergie` (index.html).
