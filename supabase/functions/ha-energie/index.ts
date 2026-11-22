// Kring – energiepagina: leest evcc (via Home Assistant) en zet de laadmodus Uit / Slim / Snel.
// De app praat nooit rechtstreeks met Home Assistant: het HA-token staat enkel hier, als geheim.
//
// Geheimen (Supabase → Edge Functions → Secrets): HA_URL (Nabu Casa-adres, zonder / op het einde), HA_TOKEN.
// In Home Assistant (configuration.yaml): rest_command.kring_evcc_state en rest_command.kring_evcc_mode (zie README).
// Toegang: gezin.energie_toegang() — lezen voor elk lid van het gekoppelde gezin, sturen enkel voor beheerder en lid.
// Deploy: supabase functions deploy ha-energie --no-verify-jwt
//   De functie controleert zelf: elke actie behalve "tick" gaat via gezin.energie_toegang() met het JWT van de gebruiker
//   (zonder geldig JWT: geen toegang). "tick" komt van pg_cron (gezin.laadvenster_cron) met een geheim token.
//
// Body: { actie: "status" }                       → live, prijzen, zonneverwachting, laadpunt, wagens (met laadplan), tijdsvenster
//       { actie: "historiek", dag?: "gisteren" }  → net, zon en wagen per kwartier (HA-statistieken); gisteren ook de prijzen
//       { actie: "laadmodus", modus: "smart"|"now"|"off" }  → buiten een actief tijdsvenster enkel onthouden
//       { actie: "venster", actief, van: "22:00", tot: "07:00" } → tijdsvenster instellen en meteen toepassen
//       { actie: "altijd", waarde: "on"|"off" }     → Slim met "Altijd laden" (min 6 A, zon extra) (rest_command.kring_evcc_alwayscharge)
//       { actie: "stroom", ampere: 6..16 }         → maximale laadstroom (rest_command.kring_evcc_maxcurrent)
//       { actie: "minstroom", ampere: 6..13 }      → minimale laadstroom, o.a. voor Altijd laden (rest_command.kring_evcc_mincurrent)
//       { actie: "toch", uren: n|null|0, modus }   → buiten het venster toch laden (n uur, null = tot het venster begint, 0 = stoppen)
//       { actie: "dagkost", dagen?: 31 }           → kost per dag (afname − injectie + vaste kost) en per maand, met de maandpiek;
//                                                     voor elk lid van het gekoppelde gezin
//       { actie: "dagprijzen", token }             → pg_cron (elk uur): ontbrekende dagprijzen ophalen bij Frank (publiek),
//                                                     de kost per dag bijwerken (gezin.energie_dagkost), net, zon en wagen
//                                                     per kwartier bewaren (gezin.energie_kwartier, gisteren en vandaag) en
//                                                     de zonneverwachting en kwartierprijzen van evcc bewaren (gezin.zon_forecast, gezin.prijs_forecast)
//       { actie: "kwartier_backfill", token, per: "uur"|"kwartier", van?, tot? }
//                                                  → eenmalig aanvullen van gezin.energie_kwartier (max. 31 dagen per oproep):
//                                                     "uur" voor oudere dagen (langetermijnstatistieken), "kwartier" voor de
//                                                     laatste KW_DAGEN dagen (5-minutenstatistieken)
//       { actie: "regels", aan: true|false }       → laadregel van de aangesloten wagen volgen (true) of pauzeren voor deze sessie (false);
//                                                     manuele acties (laadmodus, toch, altijd) pauzeren de regel ook. Sturing zelf: laadpaal-bewaking
//       { actie: "tick", token }                   → pg_cron: vensters toepassen bij een overgang, en buiten het venster
//                                                     om de 5 min nakijken of evcc nog op Uit staat (bewaking)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const antwoord = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const HA_URL = (Deno.env.get("HA_URL") || "").replace(/\/+$/, "");
const HA_TOKEN = Deno.env.get("HA_TOKEN") || "";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const NET = "sensor.p1_meter_vermogen";                       // W, + = afname, − = injectie
const ZON = "sensor.solis_inverter_0114_inverter_ac_power";   // W
const WAGEN = "sensor.wagen_laadvermogen";                     // W, REST-sensor op evcc (sinds 14/11/2026)
const MODI = ["off", "smart", "now"];
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AMPERE = [6, 8, 10, 13, 16];   // enkelfasig, max 16 A (zoals ingesteld in evcc)

async function rpc(auth: string, naam: string, args: Record<string, unknown> = {}, sleutel = SB_ANON) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${naam}`, {
    method: "POST",
    headers: { apikey: sleutel, Authorization: auth, "Content-Type": "application/json", "Content-Profile": "gezin", "Accept-Profile": "gezin" },
    body: JSON.stringify(args),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(JSON.parse(t || "{}").message || `rpc ${naam}: ${r.status}`);
  return t ? JSON.parse(t) : null;
}

async function haDienst(dienst: string, data: Record<string, unknown> = {}) {
  const r = await fetch(`${HA_URL}/api/services/rest_command/${dienst}?return_response`, {
    method: "POST",
    headers: { Authorization: `Bearer ${HA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 400 && dienst === "kring_evcc_maxcurrent") throw new Error("Laadstroom kiezen is nog niet ingesteld in Home Assistant (rest_command.kring_evcc_maxcurrent)");
  if (!r.ok) throw new Error(`Home Assistant gaf fout ${r.status}`);
  const j = await r.json();
  const resp = j.service_response || {};
  if (resp.status && resp.status >= 400) throw new Error(`evcc gaf fout ${resp.status}`);
  return resp.content;
}

const rond = (x: unknown, d = 0) => (typeof x === "number" && isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

async function evccStatus() {
  const c = await haDienst("kring_evcc_state");
  const s = c?.result || c || {};
  const lp = (s.loadpoints || [])[0] || {};
  const f = s.forecast || {};
  const circuit = Object.values(s.circuits || {})[0] as { maxPower?: number; power?: number } | undefined;
  return {
    tijd: new Date().toISOString(),
    live: {
      zon: rond(s.pvPower), huis: rond(s.homePower), net: rond(s.grid?.power), wagen: rond(lp.chargePower),
      prijs: rond(s.tariffGrid, 4), injectie: rond(s.tariffFeedIn, 4),
      netLimiet: rond(circuit?.maxPower), zelfvoorziening: rond(s.greenShareHome, 3),
    },
    laadpunt: {
      titel: lp.title || "Laadpaal", modus: lp.mode, altijdLaden: lp.alwaysCharge, verbonden: !!lp.connected, laadt: !!lp.charging,
      vermogen: rond(lp.chargePower), sessieKwh: rond((lp.sessionEnergy || 0) / 1000, 2), sessieDuurMin: rond((lp.chargeDuration || 0) / 60),
      wagen: lp.vehicleTitle || lp.vehicleName || "", soc: lp.vehicleSoc || null, plan: !!lp.planActive, maxA: lp.effectiveMaxCurrent || null,
      ingesteldA: lp.maxCurrent || null, minA: lp.minCurrent || null, nuA: rond(lp.offeredCurrent, 1), fasen: lp.phasesActive || lp.phasesConfigured || 1,
      resterendS: lp.charging ? rond(lp.chargeRemainingDuration) || null : null, limiet: rond(lp.effectiveLimitSoc) || null, bereik: rond(lp.vehicleRange) || null,
    },
    voertuigen: Object.values(s.vehicles || {}).map((v) => (v as { title?: string }).title).filter(Boolean) as string[],
    // [start (s), eind (s), €/kWh] per kwartier
    prijzen: (f.grid || []).map((p: number[] | { start: string; end: string; value: number }) => Array.isArray(p) ? [p[0], p[1], rond(p[2], 4)]
      : [Math.round(Date.parse(p.start) / 1000), Math.round(Date.parse(p.end) / 1000), rond(p.value, 4)]),
    injectie: (f.feedin || []).map((p: number[]) => [p[0], p[1], rond(p[2], 4)]),
    // [tijd (s), W] per kwartier
    zon: (f.solar?.timeseries || []).map((p: number[] | { ts: string; val: number }) => Array.isArray(p) ? [p[0], rond(p[1])] : [Math.round(Date.parse(p.ts) / 1000), rond(p.val)]),
    zonKwh: { vandaag: rond((f.solar?.today?.energy || 0) / 1000, 1), morgen: rond((f.solar?.tomorrow?.energy || 0) / 1000, 1) },
  };
}

// Net en zon per kwartier voor één dag (vandaag of gisteren), uit de 5-minutenstatistieken van HA (websocket).
// Voor gisteren ook de prijs per kwartier: sensor.frank_current_price + dezelfde toeslag als in evcc
// (evcc: 1,1321 × markt + 0,0159 + 0,1205; de Frank-sensor is 1,1321 × markt + 0,0159). Pas TOESLAG mee aan als evcc wijzigt.
const FRANK = "sensor.frank_current_price";
const TOESLAG = 0.1205;
function middernacht(dagen: number) {
  const lokaal = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Brussels" }));   // Deno draait in UTC
  const verschil = Date.now() - lokaal.getTime();
  lokaal.setHours(0, 0, 0, 0); lokaal.setDate(lokaal.getDate() + dagen);
  return new Date(Math.round((lokaal.getTime() + verschil) / 900000) * 900000);   // afronden: toLocaleString verliest de milliseconden
}
function historiek(dag: string): Promise<{ van: number; tot: number; net: [number, number][]; zon: [number, number][]; wagen: [number, number][]; prijzen?: [number, number, number][] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(HA_URL.replace(/^http/, "ws") + "/api/websocket");
    const stop = setTimeout(() => { try { ws.close(); } catch { /* */ } reject(new Error("Home Assistant antwoordt niet")); }, 15000);
    const gisteren = dag === "gisteren";
    const start = middernacht(gisteren ? -1 : 0), eind = gisteren ? middernacht(0) : new Date();
    const uit: { stat?: Record<string, { start: number; mean: number }[]>; prijs?: Record<string, { s: string; lu: number }[]> } = {};
    const klaar = () => {
      if (!uit.stat || (gisteren && !uit.prijs)) return;
      clearTimeout(stop); ws.close();
      const perKwartier = (rijen: { start: number; mean: number }[] = []) => {
        const b = new Map<number, number[]>();
        for (const r of rijen) { const k = Math.floor(r.start / 900000) * 900; if (!b.has(k)) b.set(k, []); b.get(k)!.push(r.mean); }
        return [...b].map(([k, v]) => [k, Math.round(v.reduce((a, x) => a + x, 0) / v.length)] as [number, number]);
      };
      const res: { van: number; tot: number; net: [number, number][]; zon: [number, number][]; wagen: [number, number][]; prijzen?: [number, number, number][] } =
        { van: start.getTime() / 1000, tot: (gisteren ? eind.getTime() : middernacht(1).getTime()) / 1000, net: perKwartier(uit.stat[NET]), zon: perKwartier(uit.stat[ZON]), wagen: perKwartier(uit.stat[WAGEN]) };
      if (gisteren) {
        const w = (uit.prijs![FRANK] || []).map((x) => [x.lu, parseFloat(x.s)] as [number, number]).filter((x) => isFinite(x[1])).sort((a, b) => a[0] - b[0]);
        res.prijzen = [];
        for (let t = res.van; t < res.tot; t += 900) {
          let v: number | null = null; for (const [lu, p] of w) { if (lu <= t + 5) v = p; else break; }
          if (v != null) res.prijzen.push([t, t + 900, Math.round((v + TOESLAG) * 10000) / 10000]);
        }
      }
      resolve(res);
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: HA_TOKEN }));
      else if (m.type === "auth_invalid") { clearTimeout(stop); ws.close(); reject(new Error("HA-token ongeldig")); }
      else if (m.type === "auth_ok") {
        ws.send(JSON.stringify({ id: 1, type: "recorder/statistics_during_period", start_time: start.toISOString(), end_time: eind.toISOString(), statistic_ids: [NET, ZON, WAGEN], period: "5minute", types: ["mean"] }));
        if (gisteren) ws.send(JSON.stringify({ id: 2, type: "history/history_during_period", start_time: new Date(start.getTime() - 3600e3).toISOString(), end_time: eind.toISOString(), entity_ids: [FRANK], minimal_response: true, no_attributes: true }));
      } else if (m.id === 1 || m.id === 2) {
        if (!m.success) { clearTimeout(stop); ws.close(); return reject(new Error("Historiek niet beschikbaar")); }
        if (m.id === 1) uit.stat = m.result; else uit.prijs = m.result;
        klaar();
      }
    };
    ws.onerror = () => { clearTimeout(stop); reject(new Error("Verbinding met Home Assistant mislukt")); };
  });
}

async function vensterLees(auth: string) {
  const r = await fetch(`${SB_URL}/rest/v1/laadvenster?select=actief,van,tot,modus,status,uitzondering_tot`, { headers: { apikey: SB_ANON, Authorization: auth, "Accept-Profile": "gezin" } });
  const j = r.ok ? await r.json() : [];
  const v = j[0];
  if (!v) return { actief: false, van: "22:00", tot: "07:00", modus: "smart", binnen: true };
  return { ...v, van: v.van.slice(0, 5), tot: v.tot.slice(0, 5), binnen: binnenVenster(v.van, v.tot) };
}
function binnenVenster(van: string, tot: string, op = new Date()) {
  const nu = op.toLocaleTimeString("en-GB", { timeZone: "Europe/Brussels", hour12: false }).slice(0, 5), a = van.slice(0, 5), b = tot.slice(0, 5);
  return a === b ? true : a < b ? nu >= a && nu < b : nu >= a || nu < b;
}
// Wagens: de voertuigen uit evcc, aangevuld met gezin.wagens (naam, HA-sensoren). Batterij en bereik komen uit evcc
// als de wagen aan de laadpaal hangt, anders uit de HA-sensoren (bv. de Volvo-integratie). De foto haalt de app zelf op.
type Wagen = { evcc: string; soc: number | null; bereik: number | null; aanPaal: boolean; laadt: boolean; vermogen: number | null; resterendS: number | null; limiet: number | null; plan?: unknown; socStand?: string | null };
async function haTekst(id: string | null) {
  if (!id || !/^sensor\.[a-z0-9_]+$/.test(id)) return null;
  try {
    const r = await fetch(`${HA_URL}/api/states/${id}`, { headers: { Authorization: `Bearer ${HA_TOKEN}` }, signal: AbortSignal.timeout(8000) });
    return r.ok ? String((await r.json()).state) : null;
  } catch { return null; }
}
async function haWaarde(id: string | null) {
  if (!id || !/^sensor\.[a-z0-9_]+$/.test(id)) return null;
  try {
    const r = await fetch(`${HA_URL}/api/states/${id}`, { headers: { Authorization: `Bearer ${HA_TOKEN}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const v = parseFloat((await r.json()).state);
    return isFinite(v) ? v : null;
  } catch { return null; }
}
async function wagensLees(auth: string, st: Awaited<ReturnType<typeof evccStatus>>): Promise<Wagen[]> {
  const r = await fetch(`${SB_URL}/rest/v1/wagens?select=id,evcc_titel,soc_sensor,bereik_sensor,soc_tijd_sensor,soc_max_min,volgorde,regel_modus&order=volgorde`, { headers: { apikey: SB_ANON, Authorization: auth, "Accept-Profile": "gezin" } });
  const cfg = (r.ok ? await r.json() : []) as { id: string; evcc_titel: string; soc_sensor: string | null; bereik_sensor: string | null; soc_tijd_sensor: string | null; soc_max_min: number | null; regel_modus: string | null }[];
  const namen = [...cfg.map((c) => c.evcc_titel), ...st.voertuigen.filter((t) => !cfg.some((c) => c.evcc_titel === t))];
  const lp = st.laadpunt;
  return Promise.all(namen.map(async (evcc) => {
    const c = cfg.find((x) => x.evcc_titel === evcc);
    const aanPaal = lp.verbonden && lp.wagen === evcc, laadt = aanPaal && lp.laadt;
    let [soc, bereik] = aanPaal && lp.soc ? [lp.soc, lp.bereik] : await Promise.all([haWaarde(c?.soc_sensor || null), haWaarde(c?.bereik_sensor || null)]);
    // Batterij% uit HA enkel als de wagen recent gegevens stuurde (Audi EU Data Act loopt soms een dag achter)
    let socStand: string | null = null;
    if (!(aanPaal && lp.soc) && c?.soc_tijd_sensor) {
      const t = Date.parse(String(await haTekst(c.soc_tijd_sensor)));
      if (!isFinite(t) || Date.now() - t > (c.soc_max_min ?? 60) * 60000) { soc = null; bereik = null; socStand = isFinite(t) ? new Date(t).toISOString() : "onbekend"; }
    }
    // Verwachting volgens de laadregel (gezin.laadplan): verwacht laadniveau, wanneer, zon/net, kost, overrule
    const plan = c?.regel_modus ? await rpc(auth, "laadplan_kring", { p_wagen: c.id, p_soc: rond(soc) }).catch(() => null) : null;
    if (plan && typeof plan === "object") delete (plan as Record<string, unknown>).kwartieren;
    return { evcc, soc: rond(soc), bereik: rond(bereik), aanPaal, laadt, vermogen: laadt ? lp.vermogen : null, resterendS: laadt ? lp.resterendS : null, limiet: aanPaal ? lp.limiet : null, plan, socStand };
  }));
}
// Dagprijzen: gemiddelde all-in prijs per dag (gezin.energie_dagprijs). Bron = publieke marktprijzen van Frank (BE),
// omgerekend zoals in evcc: FACTOR × markt + VAST + TOESLAG. Een dag telt pas met ≥ 92 kwartieren (zomeruur: 92–100).
const FACTOR = 1.1321, VAST = 0.0159, HISTORIEK_VAN = "2026-01-01", REF_DAGEN = 60;
const isoDag = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Brussels" });
async function frankRuw(dag: string) {
  const q = `query MarketPrices($date: String!, $resolution: PriceResolution!) { marketPrices(date: $date, resolution: $resolution) { electricityPrices { from marketPrice } } }`;
  const r = await fetch("https://graphql.frankenergie.nl/", {
    method: "POST", headers: { "Content-Type": "application/json", "x-country": "BE" },
    body: JSON.stringify({ query: q, variables: { date: dag, resolution: "PT15M" }, operationName: "MarketPrices" }), signal: AbortSignal.timeout(10000),
  });
  const j = await r.json();
  return (j?.data?.marketPrices?.electricityPrices || []) as { from: string; marketPrice: number }[];
}
async function frankDag(dag: string) {
  const p = (await frankRuw(dag)).map((x) => FACTOR * x.marketPrice + VAST + TOESLAG).filter((v) => isFinite(v));
  if (p.length < 92) return null;
  return { dag, gem: rond(p.reduce((a, b) => a + b, 0) / p.length, 5), min: rond(Math.min(...p), 5), max: rond(Math.max(...p), 5), kwartieren: p.length, bijgewerkt: new Date().toISOString() };
}
async function dagprijzenBij(max = 40) {
  const h = { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Accept-Profile": "gezin", "Content-Profile": "gezin" };
  const r = await fetch(`${SB_URL}/rest/v1/energie_dagprijs?select=dag&dag=gte.${HISTORIEK_VAN}`, { headers: h });
  const er = new Set(((r.ok ? await r.json() : []) as { dag: string }[]).map((x) => x.dag));
  const morgen = new Date(Date.now() + 864e5), te: string[] = [];
  for (let d = new Date(`${HISTORIEK_VAN}T12:00:00Z`); isoDag(d) <= isoDag(morgen); d = new Date(d.getTime() + 864e5)) if (!er.has(isoDag(d))) te.push(isoDag(d));
  const rijen = [];
  for (const dag of te.reverse().slice(0, max)) { const x = await frankDag(dag).catch(() => null); if (x) rijen.push(x); }   // nieuwste eerst
  if (rijen.length) {
    const w = await fetch(`${SB_URL}/rest/v1/energie_dagprijs`, { method: "POST", headers: { ...h, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(rijen) });
    if (!w.ok) throw new Error(`dagprijzen bewaren: ${w.status}`);
  }
  return { ontbrak: te.length, bewaard: rijen.length };
}
// Referentie voor de dagklasse: tertielen van de laatste REF_DAGEN volledige dagen vóór vandaag.
async function dagprijzenLees(auth: string) {
  const van = isoDag(new Date(Date.now() - (REF_DAGEN + 1) * 864e5));
  const r = await fetch(`${SB_URL}/rest/v1/energie_dagprijs?select=dag,gem&dag=gte.${van}&order=dag`, { headers: { apikey: SB_ANON, Authorization: auth, "Accept-Profile": "gezin" } });
  const rij = (r.ok ? await r.json() : []) as { dag: string; gem: number }[];
  const vandaag = isoDag(new Date()), ref = rij.filter((x) => x.dag < vandaag).map((x) => Number(x.gem)).sort((a, b) => a - b);
  const q = (p: number) => ref.length ? rond(ref[Math.min(ref.length - 1, Math.floor(p * ref.length))], 4) : null;
  return { laag: q(1 / 3), hoog: q(2 / 3), n: ref.length, dagen: Object.fromEntries(rij.filter((x) => x.dag >= isoDag(new Date(Date.now() - 2 * 864e5))).map((x) => [x.dag, Number(x.gem)])) };
}
// ---------- Kost per dag (gezin.energie_dagkost) ----------
// Afname en injectie (kWh) komen uit de statistieken van HA voor de netmeters van het energiedashboard (energy/get_prefs):
// de toename van de teller per 5 minuten (laatste KW_DAGEN dagen) of per uur (ouder: HA bewaart 5-minutenwaarden ±10 dagen).
// Elk kwartier wordt gewogen met de marktprijs van Frank van dat kwartier. Bewaard worden de kWh en Σ kWh × marktprijs;
// de euro's volgen pas bij het lezen uit de formules hieronder, zodat een aangepaste formule voor de hele historiek geldt.
//   afname   = FACTOR × markt + VAST + TOESLAG   (all-in, zoals evcc en de dagprijs)
//   injectie = INJ_FACTOR × markt + INJ_VAST     (voorlopig: de factuur van september 2026 gaf markt − 1,85 ct; nog te ijken)
// VASTE_KOST_DAG: vaste vergoeding Frank + databeheer (€46,93 per jaar). Capaciteitstarief Fluvius Halle-Vilvoorde 2026:
// CAP_KW_JAAR per kW maandpiek (hoogste kwartiergemiddelde afname, minstens CAP_MIN_KW). De piek is enkel te bepalen uit
// dagen met kwartierwaarden; de meter van Fluvius blijft de referentie.
const INJ_FACTOR = 1, INJ_VAST = -0.0185, VASTE_KOST_DAG = 0.1286, CAP_KW_JAAR = 59.41, CAP_MIN_KW = 2.5;
const KOST_VAN = "2026-08-01";   // de P1-statistieken in HA beginnen in augustus 2026
const KW_DAGEN = 8;               // zo ver terug vragen we 5-minutenwaarden (met een dag marge op de 10 dagen van HA)
const MAX_KW = 40;                // gemiddeld vermogen daarboven kan niet: zo'n rij is geen meting (zie spreid)
const NET_AF = ["sensor.p1_meter_energie_import"], NET_IN = ["sensor.p1_meter_energie_export"];   // reserve als HA geen energie-instellingen geeft

const BRUSSEL = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
function tzVerschil(ms: number) {   // Belgische tijd − UTC op dat ogenblik, in ms
  const p: Record<string, number> = {};
  for (const x of BRUSSEL.formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
// Begin van een kalenderdag in België (Unix, seconden). Het zomeruur wisselt om 01:00 UTC, dus nooit rond middernacht.
function dagStart(dag: string) {
  const [j, m, d] = dag.split("-").map(Number), utc = Date.UTC(j, m - 1, d);
  return (utc - tzVerschil(utc - tzVerschil(utc))) / 1000;
}
const dagPlus = (dag: string, n: number) => new Date(Date.parse(`${dag}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

type StatRij = { start: number; change?: number | null };
type Kw = { kwh: number; dek: number; geschat: boolean };   // per kwartier: kWh, gedekte seconden, verdeeld over een gat
type Bron = { af: Map<number, Kw>; inj: Map<number, Kw>; per: "kwartier" | "uur" };

// Verdeelt de toename per periode (P seconden) over de kwartieren. Na een gat (HA lag stil) bevat de eerste rij de hele
// inhaalbeweging: die wordt gelijkmatig over het gat verdeeld en als geschat gemarkeerd, zodat er geen valse piek ontstaat.
function spreid(rijen: StatRij[] | undefined, P: number) {
  const uit = new Map<number, Kw>();
  let vorig: number | null = null;   // einde van de vorige rij (s)
  for (const r of [...(rijen || [])].sort((a, b) => a.start - b.start)) {
    if (typeof r.change !== "number" || !isFinite(r.change)) continue;
    const s = Math.round(r.start / 1000), e = s + P, van = vorig !== null && vorig < s ? vorig : s, gat = van < s;
    vorig = e;
    // Onmogelijk veel: de eerste rij na opgeruimde historiek draagt de hele tellerstand. Overslaan = niet gemeten.
    if (r.change / ((e - van) / 3600) > MAX_KW) continue;
    for (let q = Math.floor(van / 900) * 900; q < e; q += 900) {
      const o = Math.min(e, q + 900) - Math.max(van, q);
      if (o <= 0) continue;
      const k = uit.get(q) || { kwh: 0, dek: 0, geschat: false };
      k.kwh += Math.max(0, r.change) * o / (e - van); k.dek += o; if (gat || r.change < 0) k.geschat = true;
      uit.set(q, k);
    }
  }
  return uit;
}
// Meerdere tellers (bv. dag- en nachttarief) optellen. Een kwartier is gedekt zodra één teller het volledig dekt.
function reeks(stat: Record<string, StatRij[]>, ids: string[], P: number) {
  const uit = new Map<number, Kw>();
  for (const id of ids) for (const [q, k] of spreid(stat[id], P)) {
    const t = uit.get(q);
    if (!t) uit.set(q, { ...k }); else { t.kwh += k.kwh; t.dek = Math.max(t.dek, k.dek); t.geschat = t.geschat || k.geschat; }
  }
  return uit;
}
// Eén dag [t0, t1) optellen tot nu. De piek telt enkel bij kwartierwaarden, op volledig gemeten, niet-geschatte kwartieren.
function dagSom(t0: number, t1: number, nu: number, b: Bron, markt: Map<number, number>) {
  const s = { afname_kwh: 0, injectie_kwh: 0, afname_markt: 0, injectie_markt: 0, piek_kw: null as number | null, piek_om: null as string | null,
    per: b.per, gemeten: 0, verwacht: Math.round((t1 - t0) / 900), geschat: 0, zonder_prijs: 0 };
  for (let q = t0; q < t1 && q < nu; q += 900) {
    const a = b.af.get(q), i = b.inj.get(q);
    if (!a && !i) continue;
    const ak = a ? a.kwh : 0, ik = i ? i.kwh : 0, m = markt.get(q);
    const vol = Math.max(a ? a.dek : 0, i ? i.dek : 0) >= 890, gs = !!(a && a.geschat) || !!(i && i.geschat);
    s.afname_kwh += ak; s.injectie_kwh += ik;
    if (m == null) { if (ak > 0.0005 || ik > 0.0005) s.zonder_prijs++; } else { s.afname_markt += ak * m; s.injectie_markt += ik * m; }
    if (vol) s.gemeten++;
    if (gs) s.geschat++;
    if (b.per === "kwartier" && vol && !gs && (s.piek_kw === null || ak * 4 > s.piek_kw)) { s.piek_kw = ak * 4; s.piek_om = new Date(q * 1000).toISOString(); }
  }
  return s;
}

// Eén websocket-sessie met HA. `werk` krijgt een functie die een vraag stuurt en op het antwoord wacht.
function haSessie<T>(werk: (vraag: (v: Record<string, unknown>) => Promise<unknown>) => Promise<T>, wachtMs = 25000): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(HA_URL.replace(/^http/, "ws") + "/api/websocket");
    const open = new Map<number, { ok: (r: unknown) => void; nok: (e: Error) => void }>();
    let id = 0, af = false;
    const einde = (fout: Error | null, waarde?: T) => { if (af) return; af = true; clearTimeout(stop); try { ws.close(); } catch { /* */ } if (fout) reject(fout); else resolve(waarde as T); };
    const stop = setTimeout(() => einde(new Error("Home Assistant antwoordt niet")), wachtMs);
    const vraag = (v: Record<string, unknown>) => new Promise<unknown>((ok, nok) => { open.set(++id, { ok, nok }); ws.send(JSON.stringify({ id, ...v })); });
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: HA_TOKEN }));
      else if (m.type === "auth_invalid") einde(new Error("HA-token ongeldig"));
      else if (m.type === "auth_ok") werk(vraag).then((w) => einde(null, w), (x) => einde(x instanceof Error ? x : new Error(String(x))));
      else if (m.type === "result" && open.has(m.id)) {
        const p = open.get(m.id)!; open.delete(m.id);
        if (m.success) p.ok(m.result); else p.nok(new Error(m.error?.message || "Home Assistant gaf een fout"));
      }
    };
    ws.onerror = () => einde(new Error("Verbinding met Home Assistant mislukt"));
    ws.onclose = () => einde(new Error("Verbinding met Home Assistant verbroken"));
  });
}
// De netmeters zoals ze in het energiedashboard van HA staan (afname en injectie, eventueel per tarief).
async function netMeters(vraag: (v: Record<string, unknown>) => Promise<unknown>) {
  try {
    const p = await vraag({ type: "energy/get_prefs" }) as { energy_sources?: Record<string, unknown>[] };
    const af: string[] = [], inj: string[] = [];
    const bij = (l: string[], v: unknown) => { if (typeof v === "string" && v && !l.includes(v)) l.push(v); };
    for (const s of p?.energy_sources || []) {
      if (s.type !== "grid") continue;
      bij(af, s.stat_energy_from); bij(inj, s.stat_energy_to);
      for (const f of (s.flow_from as Record<string, unknown>[]) || []) bij(af, f.stat_energy_from);
      for (const f of (s.flow_to as Record<string, unknown>[]) || []) bij(inj, f.stat_energy_to);
    }
    if (af.length) return { af, inj };
  } catch { /* geen energie-instellingen in HA: de reserve hieronder */ }
  return { af: NET_AF, inj: NET_IN };
}
// Marktprijs per kwartier (Unix-seconden → €/kWh) voor één dag; uurprijzen gelden voor hun vier kwartieren.
async function frankMarkt(dag: string) {
  const p = (await frankRuw(dag)).map((x) => [Math.round(Date.parse(x.from) / 1000), Number(x.marketPrice)] as [number, number])
    .filter((x) => isFinite(x[0]) && isFinite(x[1])).sort((a, b) => a[0] - b[0]);
  const stap = p.length > 1 ? Math.max(900, Math.min(3600, ...p.slice(1).map((x, i) => x[0] - p[i][0]))) : 900;
  const m = new Map<number, number>();
  for (const [t, v] of p) for (let q = t; q < t + stap; q += 900) m.set(q, v);
  return m;
}

// Vult gezin.energie_dagkost aan: vandaag, ontbrekende dagen en dagen die vóór hun einde berekend zijn (nieuwste eerst).
async function dagkostBij(huishouden: string, max = 40) {
  const h = { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Accept-Profile": "gezin", "Content-Profile": "gezin" };
  const nu = Math.floor(Date.now() / 1000), vandaag = isoDag(new Date()), recentVan = dagPlus(vandaag, -KW_DAGEN);
  const scanVan = [KOST_VAN, dagPlus(vandaag, -400)].sort()[1];
  const r = await fetch(`${SB_URL}/rest/v1/energie_dagkost?select=dag,bijgewerkt&huishouden_id=eq.${huishouden}&dag=gte.${scanVan}&order=dag.desc&limit=500`, { headers: h });
  if (!r.ok) throw new Error(`dagkost lezen: ${r.status}`);
  const er = new Map(((await r.json()) as { dag: string; bijgewerkt: string }[]).map((x) => [x.dag, Date.parse(x.bijgewerkt) / 1000]));
  const te: string[] = [];
  for (let d = vandaag; d >= scanVan && te.length < max; d = dagPlus(d, -1)) {
    const b = er.get(d);
    if (d === vandaag || b == null || b < dagStart(dagPlus(d, 1)) + 900) te.push(d);
  }
  const recent = te.filter((d) => d >= recentVan);
  const [ha, prijzen] = await Promise.all([
    haSessie(async (vraag) => {
      const ids = await netMeters(vraag);
      const stat = (van: string, period: string) => vraag({ type: "recorder/statistics_during_period", period, types: ["change"], units: { energy: "kWh" },
        statistic_ids: [...ids.af, ...ids.inj], start_time: new Date((dagStart(van) - 86400) * 1000).toISOString(), end_time: new Date((nu + 300) * 1000).toISOString() }) as Promise<Record<string, StatRij[]>>;
      const [uur, vijf] = await Promise.all([stat(te[te.length - 1], "hour"), recent.length ? stat(recent[recent.length - 1], "5minute") : Promise.resolve({} as Record<string, StatRij[]>)]);
      return { ids, uur, vijf };
    }),
    (async () => {   // prijzen per dag, 5 tegelijk
      const uit = new Map<string, Map<number, number> | null>();
      for (let i = 0; i < te.length; i += 5) await Promise.all(te.slice(i, i + 5).map(async (d) => uit.set(d, await frankMarkt(d).catch(() => null))));
      return uit;
    })(),
  ]);
  const { ids } = ha;
  if (![...Object.values(ha.uur), ...Object.values(ha.vijf)].some((l) => (l || []).length)) throw new Error(`Geen statistieken in Home Assistant voor ${[...ids.af, ...ids.inj].join(", ")}`);
  const bU: Bron = { af: reeks(ha.uur, ids.af, 3600), inj: reeks(ha.uur, ids.inj, 3600), per: "uur" };
  const b5: Bron = { af: reeks(ha.vijf, ids.af, 300), inj: reeks(ha.vijf, ids.inj, 300), per: "kwartier" };
  const rijen = [];
  let zonderPrijzen = 0;
  for (const dag of te) {
    const t0 = dagStart(dag), t1 = dagStart(dagPlus(dag, 1)), markt = prijzen.get(dag) || new Map<number, number>();
    let geprijsd = 0; for (let q = t0; q < t1; q += 900) if (markt.has(q)) geprijsd++;
    // Onvolledige prijzen: later opnieuw proberen. Na 3 dagen toch bewaren (met zonder_prijs), zodat de dag niet blijft hangen.
    if (geprijsd < (t1 - t0) / 900 && dag > dagPlus(vandaag, -3)) { zonderPrijzen++; continue; }
    const u = dagSom(t0, t1, nu, bU, markt), k = dag >= recentVan ? dagSom(t0, t1, nu, b5, markt) : null;
    const s = k && k.gemeten >= u.gemeten ? k : u;
    rijen.push({ huishouden_id: huishouden, dag, afname_kwh: rond(s.afname_kwh, 3), injectie_kwh: rond(s.injectie_kwh, 3), afname_markt: rond(s.afname_markt, 5), injectie_markt: rond(s.injectie_markt, 5),
      piek_kw: s.piek_kw === null ? null : rond(s.piek_kw, 3), piek_om: s.piek_om, per: s.per, gemeten: s.gemeten, verwacht: s.verwacht, geschat: s.geschat, zonder_prijs: s.zonder_prijs, bijgewerkt: new Date().toISOString() });
  }
  if (rijen.length) {
    const w = await fetch(`${SB_URL}/rest/v1/energie_dagkost`, { method: "POST", headers: { ...h, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(rijen) });
    if (!w.ok) throw new Error(`dagkost bewaren: ${w.status}`);
  }
  return { te_doen: te.length, bewaard: rijen.length, zonder_prijzen: zonderPrijzen, meters: ids };
}
// Voor pg_cron: elk gekoppeld gezin (één Home Assistant per project, dus dezelfde meters)
async function koppelingen() {
  const r = await fetch(`${SB_URL}/rest/v1/energie_koppeling?select=huishouden_id&actief=is.true`, { headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Accept-Profile": "gezin" } });
  if (!r.ok) throw new Error(`koppeling lezen: ${r.status}`);
  return ((await r.json()) as { huishouden_id: string }[]).map((k) => k.huishouden_id);
}
async function dagkostAlle(max = 40) {
  const uit = [];
  for (const k of await koppelingen()) uit.push(await dagkostBij(k, max));
  return uit;
}

// ---------- Net, zon en laden per kwartier (gezin.energie_kwartier) ----------
// Elk uur (actie dagprijzen): gisteren en vandaag als kwartier uit de 5-minutenstatistieken van HA. Die bewaart HA maar
// ±10 dagen; deze kopie maakt ze blijvend (voor simulaties, de echte kwartierpiek en controle van de factuur).
// Eenmalig (actie kwartier_backfill): oudere dagen per uur uit de langetermijnstatistieken.
// Afname en injectie: toename van de netmeters, zoals bij de dagkost. Zon en wagen: gemiddeld vermogen (W) × tijd.
// markt_eur_kwh: marktprijs van Frank (zonder opslag); all-in = FACTOR × markt + VAST + TOESLAG.
// Een periode wordt enkel bewaard als ze voorbij is en de netmeter ze volledig dekt.
type MeanRij = { start: number; mean?: number | null };
function energieUitVermogen(rijen: MeanRij[] | undefined, P: number, emmer: number) {
  const uit = new Map<number, number>();
  for (const r of rijen || []) {
    if (typeof r.mean !== "number" || !isFinite(r.mean)) continue;
    const k = Math.floor(Math.round(r.start / 1000) / emmer) * emmer;
    uit.set(k, (uit.get(k) || 0) + Math.max(0, r.mean) * P / 3600 / 1000);
  }
  return uit;
}
async function kwartierBij(huishouden: string, van: string, tot: string, per: "kwartier" | "uur") {
  const nu = Math.floor(Date.now() / 1000);
  const P = per === "kwartier" ? 300 : 3600, emmer = per === "kwartier" ? 900 : 3600;
  const t0 = dagStart(van), t1 = Math.min(dagStart(dagPlus(tot, 1)), Math.floor(nu / emmer) * emmer);
  if (t1 <= t0) return { per, van, tot, bewaard: 0 };
  const ha = await haSessie(async (vraag) => {
    const ids = await netMeters(vraag);
    const basis = { start_time: new Date(t0 * 1000).toISOString(), end_time: new Date(t1 * 1000).toISOString(), period: per === "kwartier" ? "5minute" : "hour" };
    const [teller, vermogen] = await Promise.all([
      vraag({ type: "recorder/statistics_during_period", ...basis, types: ["change"], units: { energy: "kWh" }, statistic_ids: [...ids.af, ...ids.inj] }) as Promise<Record<string, StatRij[]>>,
      vraag({ type: "recorder/statistics_during_period", ...basis, types: ["mean"], units: { power: "W" }, statistic_ids: [ZON, WAGEN] }) as Promise<Record<string, MeanRij[]>>,
    ]);
    return { ids, teller, vermogen };
  }, 60000);
  const af = reeks(ha.teller, ha.ids.af, P), inj = reeks(ha.teller, ha.ids.inj, P);
  const zon = energieUitVermogen(ha.vermogen[ZON], P, emmer), wagen = energieUitVermogen(ha.vermogen[WAGEN], P, emmer);
  const dagen: string[] = [];
  for (let d = van; d <= tot; d = dagPlus(d, 1)) dagen.push(d);
  const markt = new Map<number, number>();
  for (let i = 0; i < dagen.length; i += 5) {
    await Promise.all(dagen.slice(i, i + 5).map(async (d) => { const m = await frankMarkt(d).catch(() => null); if (m) for (const [q, v] of m) markt.set(q, v); }));
  }
  const rijen = [], nuIso = new Date().toISOString();
  for (let t = t0; t < t1; t += emmer) {
    let a = 0, i = 0, dek = 0, gs = false, ms = 0, mn = 0;
    for (let q = t; q < t + emmer; q += 900) {
      const x = af.get(q), y = inj.get(q);
      if (x) { a += x.kwh; gs = gs || x.geschat; }
      if (y) { i += y.kwh; gs = gs || y.geschat; }
      dek += Math.min(900, Math.max(x ? x.dek : 0, y ? y.dek : 0));
      const m = markt.get(q); if (m != null) { ms += m; mn++; }
    }
    if (dek < emmer * 0.99) continue;
    rijen.push({ huishouden_id: huishouden, ts: new Date(t * 1000).toISOString(), per, afname_kwh: rond(a, 4), injectie_kwh: rond(i, 4),
      zon_kwh: zon.has(t) ? rond(zon.get(t)!, 4) : null, wagen_kwh: wagen.has(t) ? rond(wagen.get(t)!, 4) : null,
      markt_eur_kwh: mn ? rond(ms / mn, 5) : null, geschat: gs, bijgewerkt: nuIso });
  }
  const h = { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Accept-Profile": "gezin", "Content-Profile": "gezin", "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" };
  for (let k = 0; k < rijen.length; k += 500) {
    const w = await fetch(`${SB_URL}/rest/v1/energie_kwartier`, { method: "POST", headers: h, body: JSON.stringify(rijen.slice(k, k + 500)) });
    if (!w.ok) throw new Error(`kwartier bewaren: ${w.status} ${await w.text()}`);
  }
  return { per, van, tot, bewaard: rijen.length, meters: ha.ids };
}
// Zonneverwachting per kwartier uit evcc (Forecast.Solar: 4,48 kWp, azimut −20°, helling 45°, omvormer 3 kW) → gezin.zon_forecast.
// Basis voor de laadregels (gezin.laadplan, gezin.zon_advies). Elk uur, met de dagprijzen.
async function zonForecastAlle() {
  const st = await evccStatus();
  // evcc levert per kwartier of per uur; een punt geldt tot het volgende (max. 1 uur) → altijd per kwartier bewaren
  const pt = st.zon.filter((p) => p[1] != null && isFinite(p[0])).sort((a, b) => a[0] - b[0]) as [number, number][];
  const rijen: [number, number][] = [];
  for (let i = 0; i < pt.length; i++) {
    const t0 = Math.floor(pt[i][0] / 900) * 900, t1 = Math.min(i + 1 < pt.length ? pt[i + 1][0] : t0 + 900, t0 + 3600);
    for (let t = t0; t < t1; t += 900) if (!rijen.length || rijen[rijen.length - 1][0] < t) rijen.push([t, pt[i][1]]);
  }
  // Kwartierprijzen vooruit (all-in afname uit evcc) → gezin.prijs_forecast, voor het laadplan per wagen (gezin.laadplan)
  const prijzen: [number, number][] = [];
  for (const [a, b, p] of st.prijzen as [number, number, number | null][]) {
    if (p == null || !isFinite(a) || !isFinite(b)) continue;
    for (let t = Math.floor(a / 900) * 900; t < b; t += 900) prijzen.push([t, p]);
  }
  let bewaard = 0, prijsBewaard = 0;
  for (const k of await koppelingen()) {
    if (rijen.length) bewaard += await rpc(`Bearer ${SB_SERVICE}`, "zon_forecast_bewaar", { p_huishouden: k, p_rijen: rijen }, SB_SERVICE);
    if (prijzen.length) prijsBewaard += await rpc(`Bearer ${SB_SERVICE}`, "prijs_forecast_bewaar", { p_huishouden: k, p_rijen: prijzen }, SB_SERVICE);
  }
  return { bewaard, prijzen: prijsBewaard, van: rijen.length ? new Date(rijen[0][0] * 1000).toISOString() : null, tot: rijen.length ? new Date(rijen[rijen.length - 1][0] * 1000).toISOString() : null };
}
async function kwartierAlle() {
  const vandaag = isoDag(new Date()), uit = [];
  for (const k of await koppelingen()) uit.push(await kwartierBij(k, dagPlus(vandaag, -1), vandaag, "kwartier"));
  return uit;
}

type KostRij = { dag: string; afname_kwh: number; injectie_kwh: number; afname_markt: number; injectie_markt: number; piek_kw: number | null; piek_om: string | null;
  per: string; gemeten: number; verwacht: number; geschat: number; zonder_prijs: number; bijgewerkt: string };
// Kost per dag (laatste `dagen` dagen) en per maand (deze en de twee vorige), in euro volgens de formules hierboven.
async function dagkostLees(auth: string, huishouden: string, dagen: unknown) {
  const n = Math.min(92, Math.max(7, Math.round(Number(dagen)) || 31)), vandaag = isoDag(new Date());
  const eerste = dagPlus(vandaag, -(n - 1)), maandVan = dagPlus(`${vandaag.slice(0, 7)}-15`, -61).slice(0, 7) + "-01";
  const van = eerste < maandVan ? eerste : maandVan;
  const lees = async () => {
    const r = await fetch(`${SB_URL}/rest/v1/energie_dagkost?select=*&huishouden_id=eq.${huishouden}&dag=gte.${van}&order=dag`, { headers: { apikey: SB_ANON, Authorization: auth, "Accept-Profile": "gezin" } });
    if (!r.ok) throw new Error(`dagkost lezen: ${r.status}`);
    return (await r.json()) as KostRij[];
  };
  let rij = await lees(), waarschuwing: string | null = null;
  const vr = rij.find((x) => x.dag === vandaag);
  if (!vr || Date.now() - Date.parse(vr.bijgewerkt) > 75 * 60e3) {   // pg_cron werkt elk uur bij; anders hier (eerste keer, of cron viel uit)
    try { await dagkostBij(huishouden, 12); rij = await lees(); } catch (e) { waarschuwing = e instanceof Error ? e.message : String(e); }
  }
  const euro = (x: KostRij) => {
    const af = FACTOR * Number(x.afname_markt) + (VAST + TOESLAG) * Number(x.afname_kwh), inj = INJ_FACTOR * Number(x.injectie_markt) + INJ_VAST * Number(x.injectie_kwh);
    return { af, inj, netto: af - inj + VASTE_KOST_DAG };
  };
  const volledig = (x: KostRij) => x.gemeten >= x.verwacht && x.zonder_prijs === 0;
  const per = new Map(rij.filter((x) => x.gemeten > 0 || Number(x.afname_kwh) > 0 || Number(x.injectie_kwh) > 0).map((x) => [x.dag, x]));
  const dagenUit = [];
  for (let d = eerste; d <= vandaag; d = dagPlus(d, 1)) {
    const x = per.get(d);
    if (!x) { dagenUit.push({ dag: d, leeg: true }); continue; }
    const e = euro(x);
    dagenUit.push({ dag: d, afname_kwh: rond(Number(x.afname_kwh), 2), injectie_kwh: rond(Number(x.injectie_kwh), 2), afname_eur: rond(e.af, 2), injectie_eur: rond(e.inj, 2),
      vast_eur: VASTE_KOST_DAG, netto_eur: rond(e.netto, 2), volledig: volledig(x), per: x.per, gemeten: x.gemeten, verwacht: x.verwacht, geschat: x.geschat, zonder_prijs: x.zonder_prijs,
      piek_kw: x.piek_kw == null ? null : rond(Number(x.piek_kw), 2) });
  }
  const maanden = [];
  for (let m = maandVan.slice(0, 7); m <= vandaag.slice(0, 7); m = dagPlus(`${m}-28`, 7).slice(0, 7)) {
    const lijst = [...per.values()].filter((x) => x.dag.slice(0, 7) === m);
    const inMaand = Number(dagPlus(`${dagPlus(`${m}-28`, 7).slice(0, 7)}-01`, -1).slice(8));
    let af = 0, inj = 0, afK = 0, inK = 0, vol = 0, kwDagen = 0, piek: number | null = null, piekOm: string | null = null;
    for (const x of lijst) {
      const e = euro(x); af += e.af; inj += e.inj; afK += Number(x.afname_kwh); inK += Number(x.injectie_kwh);
      if (volledig(x)) vol++;
      if (x.per === "kwartier") { kwDagen++; if (x.piek_kw != null && (piek === null || Number(x.piek_kw) > piek)) { piek = Number(x.piek_kw); piekOm = x.piek_om; } }
    }
    const capKw = piek === null ? null : Math.max(piek, CAP_MIN_KW);
    maanden.push({ maand: m, dagen: lijst.length, dagen_volledig: vol, dagen_in_maand: inMaand, dagen_verstreken: m === vandaag.slice(0, 7) ? Number(vandaag.slice(8)) : inMaand,
      afname_kwh: rond(afK, 1), injectie_kwh: rond(inK, 1), afname_eur: rond(af, 2), injectie_eur: rond(inj, 2), vast_eur: rond(lijst.length * VASTE_KOST_DAG, 2),
      netto_eur: lijst.length ? rond(af - inj + lijst.length * VASTE_KOST_DAG, 2) : null,
      piek_kw: piek === null ? null : rond(piek, 2), piek_om: piekOm, piek_dagen: kwDagen,
      capaciteit_kw: capKw === null ? null : rond(capKw, 2), capaciteit_eur: capKw === null ? null : rond(capKw * CAP_KW_JAAR * inMaand / 365, 2) });
  }
  return { dagen: dagenUit, maanden, bijgewerkt: rij.reduce((a, x) => (x.bijgewerkt > a ? x.bijgewerkt : a), "") || null, waarschuwing,
    formule: { factor: FACTOR, vast: VAST, toeslag: TOESLAG, injectie_factor: INJ_FACTOR, injectie_vast: INJ_VAST, vaste_kost_dag: VASTE_KOST_DAG, capaciteit_kw_jaar: CAP_KW_JAAR, capaciteit_min_kw: CAP_MIN_KW } };
}

async function statusVoor(auth: string, sturen: boolean) {
  const [st, venster, dagprijzen] = await Promise.all([evccStatus(), vensterLees(auth), dagprijzenLees(auth).catch(() => null)]);
  const wagens = await wagensLees(auth, st).catch(() => [] as Wagen[]);
  return { ...st, wagens, venster, dagprijzen, magSturen: sturen };
}
// Pas de vensters toe die een overgang hebben (aangeroepen door pg_cron of na een wijziging)
async function vensterToepassen(token: string) {
  const svc = `Bearer ${SB_SERVICE}`;
  const rijen = await rpc(svc, "laadvenster_te_doen", { p_token: token }, SB_SERVICE) as { huishouden_id: string; modus: string; binnen: boolean; controle: boolean }[];
  for (const v of rijen || []) {
    // Hangt er een herkende wagen met een actieve laadregel (zonder overrule), dan stuurt laadpaal-bewaking: venster met rust laten
    if (await rpc(svc, "regel_stuurt", { p_huishouden: v.huishouden_id }, SB_SERVICE).catch(() => false)) continue;
    if (v.controle) {
      // Bewaking: buiten het venster moet evcc op Uit staan (bewust laden gaat via "Toch laden" in Kring)
      const nu = await haDienst("kring_evcc_state");
      const modusNu = ((nu?.result || nu || {}).loadpoints || [])[0]?.mode;
      if (modusNu && modusNu !== "off") {
        await haDienst("kring_evcc_mode", { mode: "off" });
        await rpc(svc, "laadvenster_bewaakt", { p_huishouden: v.huishouden_id, p_was: modusNu }, SB_SERVICE);
      }
    } else await haDienst("kring_evcc_mode", { mode: v.binnen ? v.modus : "off" });
    await rpc(svc, "laadvenster_toegepast", { p_huishouden: v.huishouden_id, p_status: v.binnen ? "binnen" : "buiten" }, SB_SERVICE);
  }
  return (rijen || []).length;
}
async function tickToken() {
  const r = await fetch(`${SB_URL}/rest/v1/laadvenster_tick?select=token`, { headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Accept-Profile": "gezin" } });
  const j = r.ok ? await r.json() : [];
  return j[0]?.token as string | undefined;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!HA_URL || !HA_TOKEN) return antwoord({ fout: "Home Assistant is nog niet ingesteld (HA_URL / HA_TOKEN)" }, 500);
    const body = await req.json().catch(() => ({}));
    const { actie = "status", modus, dag } = body;
    if (actie === "dagprijzen") {
      const t = await tickToken();
      if (!t || body.token !== t) return antwoord({ fout: "Geen toegang" }, 403);
      const max = Math.min(60, Number(body.max) || 40), prijzen = await dagprijzenBij(max);
      // Daarna de kost per dag, de kwartieren en de verwachtingen; een fout daar (bv. HA onbereikbaar) mag de dagprijzen niet tegenhouden
      const dagkost = await dagkostAlle(max).catch((e) => ({ fout: e instanceof Error ? e.message : String(e) }));
      const kwartier = await kwartierAlle().catch((e) => ({ fout: e instanceof Error ? e.message : String(e) }));
      const forecast = await zonForecastAlle().catch((e) => ({ fout: e instanceof Error ? e.message : String(e) }));
      return antwoord({ ...prijzen, dagkost, kwartier, forecast });
    }
    if (actie === "kwartier_backfill") {
      const t = await tickToken();
      if (!t || body.token !== t) return antwoord({ fout: "Geen toegang" }, 403);
      const per = body.per === "uur" ? "uur" : "kwartier", vandaag = isoDag(new Date()), grens = dagPlus(vandaag, -KW_DAGEN);
      const geldig = (x: unknown) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x);
      let van = geldig(body.van) ? body.van as string : (per === "uur" ? KOST_VAN : grens);
      let tot = geldig(body.tot) ? body.tot as string : vandaag;
      // Uur- en kwartierrijen mogen niet overlappen: uur enkel vóór de grens, kwartier enkel vanaf de grens
      if (per === "uur" && tot >= grens) tot = dagPlus(grens, -1);
      if (per === "kwartier" && van < grens) van = grens;
      if (van < KOST_VAN) van = KOST_VAN;
      if (tot > dagPlus(van, 30)) tot = dagPlus(van, 30);
      if (tot < van) return antwoord({ per, van, tot, bewaard: 0 });
      const uit = [];
      for (const k of await koppelingen()) uit.push(await kwartierBij(k, van, tot, per));
      return antwoord(uit);
    }
    if (actie === "tick") {
      if (typeof body.token !== "string" || body.token.length < 20) return antwoord({ fout: "Geen toegang" }, 403);
      return antwoord({ toegepast: await vensterToepassen(body.token) });
    }
    const auth = req.headers.get("Authorization") || "";
    if (!/^Bearer \S+/.test(auth)) return antwoord({ fout: "Niet aangemeld" }, 401);
    const toegang = await rpc(auth, "energie_toegang");
    if (!toegang?.lezen) return antwoord({ fout: "Geen toegang tot de energiegegevens" }, 403);

    if (actie === "status") return antwoord(await statusVoor(auth, !!toegang.sturen));
    if (actie === "historiek") return antwoord(await historiek(dag === "gisteren" ? "gisteren" : "vandaag"));
    if (actie === "dagkost") return antwoord(await dagkostLees(auth, toegang.huishouden, body.dagen));
    if (actie === "laadmodus") {
      if (!MODI.includes(modus)) return antwoord({ fout: "Onbekende laadmodus" }, 400);
      await rpc(auth, "energie_registreer", { p_actie: "laadmodus", p_waarde: modus });   // weigert tieners en kinderen
      await rpc(auth, "laadregel_overrule", { p_aan: true, p_reden: `manueel in Kring: ${modus}` }).catch(() => null);   // laadregel pauzeren voor deze sessie
      if (modus !== "off") await rpc(auth, "laadvenster_modus", { p_modus: modus });
      const v = await vensterLees(auth);
      let melding = "";
      const toch = v.uitzondering_tot && new Date(v.uitzondering_tot) > new Date();
      if (v.actief && !v.binnen && !toch && modus !== "off") melding = `Buiten het laadvenster: laadt vanaf ${v.van} in deze modus.`;
      else { await haDienst("kring_evcc_mode", { mode: modus }); await new Promise((r) => setTimeout(r, 800)); }
      return antwoord({ ...(await statusVoor(auth, true)), melding });
    }
    if (actie === "venster") {
      const tijd = (x: unknown) => typeof x === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(x);
      if (!tijd(body.van) || !tijd(body.tot)) return antwoord({ fout: "Ongeldig uur" }, 400);
      await rpc(auth, "laadvenster_zet", { p_actief: !!body.actief, p_van: body.van, p_tot: body.tot });   // weigert tieners en kinderen
      const v = await vensterLees(auth);
      if (v.actief) { const t = await tickToken(); if (t) await vensterToepassen(t); }
      else await haDienst("kring_evcc_mode", { mode: v.modus });   // venster uit: laden volgens de gekozen modus
      await new Promise((r) => setTimeout(r, 800));
      return antwoord(await statusVoor(auth, true));
    }
    if (actie === "toch") {
      const uren = body.uren === null ? null : Number(body.uren);
      if (uren !== null && !(uren >= 0 && uren <= 24)) return antwoord({ fout: "Ongeldige duur" }, 400);
      const m = body.modus === "smart" ? "smart" : "now";
      await rpc(auth, "laadvenster_toch", { p_uren: uren });   // weigert tieners en kinderen
      if (uren !== 0) await rpc(auth, "laadregel_overrule", { p_aan: true, p_reden: "Toch laden in Kring" }).catch(() => null);
      if (uren === 0) { const t = await tickToken(); if (t) await vensterToepassen(t); }   // stoppen: bewaking zet meteen op Uit
      else await haDienst("kring_evcc_mode", { mode: m });
      await new Promise((r) => setTimeout(r, 800));
      return antwoord(await statusVoor(auth, true));
    }
    if (actie === "altijd") {
      const w = body.waarde === "on" ? "on" : "off";
      await rpc(auth, "energie_registreer", { p_actie: "altijd laden", p_waarde: w });   // weigert tieners en kinderen
      await rpc(auth, "laadregel_overrule", { p_aan: true, p_reden: `Altijd laden ${w} in Kring` }).catch(() => null);
      await haDienst("kring_evcc_alwayscharge", { waarde: w });
      await new Promise((r) => setTimeout(r, 800));
      return antwoord(await statusVoor(auth, true));
    }
    if (actie === "regels") {   // knop "Regels overrulen": aan = regels volgen, uit = gepauzeerd voor de lopende sessie
      const r = await rpc(auth, "laadregel_overrule", { p_aan: !body.aan, p_reden: "knop Regels overrulen in Kring" });
      return antwoord({ ...(await statusVoor(auth, true)), melding: r?.ok ? "" : (r?.melding || "") });
    }
    if (actie === "minstroom") {
      const a = Number(body.ampere);
      if (![6, 8, 10, 13].includes(a)) return antwoord({ fout: "Ongeldige minimale laadstroom" }, 400);
      await rpc(auth, "energie_registreer", { p_actie: "minstroom", p_waarde: String(a) });
      await haDienst("kring_evcc_mincurrent", { ampere: a });
      await new Promise((r) => setTimeout(r, 800));
      return antwoord(await statusVoor(auth, true));
    }
    if (actie === "stroom") {
      const a = Number(body.ampere);
      if (!AMPERE.includes(a)) return antwoord({ fout: "Ongeldige laadstroom" }, 400);
      await rpc(auth, "energie_registreer", { p_actie: "laadstroom", p_waarde: String(a) });
      await haDienst("kring_evcc_maxcurrent", { ampere: a });
      await new Promise((r) => setTimeout(r, 800));
      return antwoord(await statusVoor(auth, true));
    }
    return antwoord({ fout: "Onbekende actie" }, 400);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return antwoord({ fout: m }, /toegang/i.test(m) ? 403 : 502);
  }
});
