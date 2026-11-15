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
// Body: { actie: "status" }                       → live, prijzen, zonneverwachting, laadpunt, tijdsvenster
//       { actie: "historiek", dag?: "gisteren" }  → net, zon en wagen per kwartier (HA-statistieken); gisteren ook de prijzen
//       { actie: "laadmodus", modus: "smart"|"now"|"off" }  → buiten een actief tijdsvenster enkel onthouden
//       { actie: "venster", actief, van: "22:00", tot: "07:00" } → tijdsvenster instellen en meteen toepassen
//       { actie: "stroom", ampere: 6..16 }         → maximale laadstroom (rest_command.kring_evcc_maxcurrent)
//       { actie: "tick", token }                   → pg_cron: vensters toepassen bij een overgang

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
      ingesteldA: lp.maxCurrent || null, fasen: lp.phasesActive || lp.phasesConfigured || 1,
    },
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
  const r = await fetch(`${SB_URL}/rest/v1/laadvenster?select=actief,van,tot,modus,status`, { headers: { apikey: SB_ANON, Authorization: auth, "Accept-Profile": "gezin" } });
  const j = r.ok ? await r.json() : [];
  const v = j[0];
  if (!v) return { actief: false, van: "22:00", tot: "07:00", modus: "smart", binnen: true };
  return { ...v, van: v.van.slice(0, 5), tot: v.tot.slice(0, 5), binnen: binnenVenster(v.van, v.tot) };
}
function binnenVenster(van: string, tot: string, op = new Date()) {
  const nu = op.toLocaleTimeString("en-GB", { timeZone: "Europe/Brussels", hour12: false }).slice(0, 5), a = van.slice(0, 5), b = tot.slice(0, 5);
  return a === b ? true : a < b ? nu >= a && nu < b : nu >= a || nu < b;
}
async function statusVoor(auth: string, sturen: boolean) {
  const [st, venster] = await Promise.all([evccStatus(), vensterLees(auth)]);
  return { ...st, venster, magSturen: sturen };
}
// Pas de vensters toe die een overgang hebben (aangeroepen door pg_cron of na een wijziging)
async function vensterToepassen(token: string) {
  const svc = `Bearer ${SB_SERVICE}`;
  const rijen = await rpc(svc, "laadvenster_te_doen", { p_token: token }, SB_SERVICE) as { huishouden_id: string; modus: string; binnen: boolean }[];
  for (const v of rijen || []) {
    await haDienst("kring_evcc_mode", { mode: v.binnen ? v.modus : "off" });
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
      if (v.actief && !v.binnen && modus !== "off") melding = `Buiten het laadvenster: laadt vanaf ${v.van} in deze modus.`;
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
