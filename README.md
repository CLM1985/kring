# Kring – gezinsplatform

Eigen vervanger voor FamilyWall (en op termijn YNAB). Versie 12 + R5 · live sinds 11/11/2026.

**App:** https://clm1985.github.io/kring/ · **Database:** Supabase-project *Gezinsbudget*, schema `gezin` (schema `ynab` = YNAB-spiegel, enkel gelezen).

## Tabs
Vandaag · Agenda · Eten (weekmenu, gerechten, boodschappen/bestellijst, diepvries, voorraad) · Lijsten · Budget, plus **+** (snel toevoegen), weekoverleg en kindmodus.

## Bestanden
| Bestand | Inhoud |
|---|---|
| `index.html` | De volledige app in één bestand (geen build nodig voor GitHub Pages) |
| `config.js` | Supabase-URL + publishable key. Leeg = demomodus in de browser |
| `manifest.webmanifest`, `icon.svg` | Installeerbaar als app op het beginscherm |
| `supabase/migrations/20261111_gezin_kring_basis.sql` | Volledig schema `gezin` met RLS (toegepast als migratie `gezin_kring_basis`) |
| `supabase/functions/recept-import` | Recept ophalen van een receptensite (JWT verplicht) |
| `supabase/functions/ics-ophalen` | Externe ICS-agenda ophalen (JWT verplicht) |
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
