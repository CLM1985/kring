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
// Body: { actie: "status" }                       → live, prijzen, zonneverwachting, laadpunt, wagens, tijdsvenster
//       { actie: "historiek", dag?: "gisteren" }  → net, zon en wagen per kwartier (HA-statistieken); gisteren ook de prijzen
//       { actie: "laadmodus", modus: "smart"|"now"|"off" }  → buiten een actief tijdsvenster enkel onthouden
//       { actie: "venster", actief, van: "22:00", tot: "07:00" } → tijdsvenster instellen en meteen toepassen
//       { actie: "altijd", waarde: "on"|"off" }     → Slim met "Altijd laden" (min 6 A, zon extra) (rest_command.kring_evcc_alwayscharge)
//       { actie: "stroom", ampere: 6..16 }         → maximale laadstroom (rest_command.kring_evcc_maxcurrent)
//       { actie: "minstroom", ampere: 6..13 }      → minimale laadstroom, o.a. voor Altijd laden (rest_command.kring_evcc_mincurrent)
//       { actie: "toch", uren: n|null|0, modus }   → buiten het venster toch laden (n uur, null = tot het venster begint, 0 = stoppen)
//       { actie: "dagprijzen", token }             → pg_cron (elk uur): ontbrekende dagprijzen ophalen bij Frank (publiek)
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
    prijzen: (f.grid || []).map((p: number[]) => [p[0], p[1], rond(p[2], 4)]),
    injectie: (f.feedin || []).map((p: number[]) => [p[0], p[1], rond(p[2], 4)]),
    // [tijd (s), W] per kwartier
    zon: (f.solar?.timeseries || []).map((p: number[]) => [p[0], rond(p[1])]),
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
type Wagen = { evcc: string; soc: number | null; bereik: number | null; aanPaal: boolean; laadt: boolean; vermogen: number | null; resterendS: number | null; limiet: number | null };
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
  const r = await fetch(`${SB_URL}/rest/v1/wagens?select=evcc_titel,soc_sensor,bereik_sensor,volgorde&order=volgorde`, { headers: { apikey: SB_ANON, Authorization: auth, "Accept-Profile": "gezin" } });
  const cfg = (r.ok ? await r.json() : []) as { evcc_titel: string; soc_sensor: string | null; bereik_sensor: string | null }[];
  const namen = [...cfg.map((c) => c.evcc_titel), ...st.voertuigen.filter((t) => !cfg.some((c) => c.evcc_titel === t))];
  const lp = st.laadpunt;
  return Promise.all(namen.map(async (evcc) => {
    const c = cfg.find((x) => x.evcc_titel === evcc);
    const aanPaal = lp.verbonden && lp.wagen === evcc, laadt = aanPaal && lp.laadt;
    const [soc, bereik] = aanPaal && lp.soc ? [lp.soc, lp.bereik] : await Promise.all([haWaarde(c?.soc_sensor || null), haWaarde(c?.bereik_sensor || null)]);
    return { evcc, soc: rond(soc), bereik: rond(bereik), aanPaal, laadt, vermogen: laadt ? lp.vermogen : null, resterendS: laadt ? lp.resterendS : null, limiet: aanPaal ? lp.limiet : null };
  }));
}
// Dagprijzen: gemiddelde all-in prijs per dag (gezin.energie_dagprijs). Bron = publieke marktprijzen van Frank (BE),
// omgerekend zoals in evcc: FACTOR × markt + VAST + TOESLAG. Een dag telt pas met ≥ 92 kwartieren (zomeruur: 92–100).
const FACTOR = 1.1321, VAST = 0.0159, HISTORIEK_VAN = "2026-01-01", REF_DAGEN = 60;
const isoDag = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Brussels" });
async function frankDag(dag: string) {
  const q = `query MarketPrices($date: String!, $resolution: PriceResolution!) { marketPrices(date: $date, resolution: $resolution) { electricityPrices { from marketPrice } } }`;
  const r = await fetch("https://graphql.frankenergie.nl/", {
    method: "POST", headers: { "Content-Type": "application/json", "x-country": "BE" },
    body: JSON.stringify({ query: q, variables: { date: dag, resolution: "PT15M" }, operationName: "MarketPrices" }), signal: AbortSignal.timeout(10000),
  });
  const j = await r.json();
  const p = ((j?.data?.marketPrices?.electricityPrices || []) as { marketPrice: number }[]).map((x) => FACTOR * x.marketPrice + VAST + TOESLAG).filter((v) => isFinite(v));
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
      return antwoord(await dagprijzenBij(Math.min(60, Number(body.max) || 40)));
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
    if (actie === "laadmodus") {
      if (!MODI.includes(modus)) return antwoord({ fout: "Onbekende laadmodus" }, 400);
      await rpc(auth, "energie_registreer", { p_actie: "laadmodus", p_waarde: modus });   // weigert tieners en kinderen
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
      if (uren === 0) { const t = await tickToken(); if (t) await vensterToepassen(t); }   // stoppen: bewaking zet meteen op Uit
      else await haDienst("kring_evcc_mode", { mode: m });
      await new Promise((r) => setTimeout(r, 800));
      return antwoord(await statusVoor(auth, true));
    }
    if (actie === "altijd") {
      const w = body.waarde === "on" ? "on" : "off";
      await rpc(auth, "energie_registreer", { p_actie: "altijd laden", p_waarde: w });   // weigert tieners en kinderen
      await haDienst("kring_evcc_alwayscharge", { waarde: w });
      await new Promise((r) => setTimeout(r, 800));
      return antwoord(await statusVoor(auth, true));
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
