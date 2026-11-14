// Kring – energiepagina: leest evcc (via Home Assistant) en zet de laadmodus Uit / Slim / Snel.
// De app praat nooit rechtstreeks met Home Assistant: het HA-token staat enkel hier, als geheim.
//
// Geheimen (Supabase → Edge Functions → Secrets): HA_URL (Nabu Casa-adres, zonder / op het einde), HA_TOKEN.
// In Home Assistant (configuration.yaml): rest_command.kring_evcc_state en rest_command.kring_evcc_mode (zie README).
// Toegang: gezin.energie_toegang() — lezen voor elk lid van het gekoppelde gezin, sturen enkel voor beheerder en lid.
// Deploy: supabase functions deploy ha-energie   (verify_jwt aan)
//
// Body: { actie: "status" }                       → live, prijzen, zonneverwachting, laadpunt
//       { actie: "historiek" }                    → net en zon van vandaag per kwartier (HA-statistieken)
//       { actie: "laadmodus", modus: "smart"|"now"|"off" }

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
const MODI = ["off", "smart", "now"];

async function rpc(auth: string, naam: string, args: Record<string, unknown> = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${naam}`, {
    method: "POST",
    headers: { apikey: SB_ANON, Authorization: auth, "Content-Type": "application/json", "Content-Profile": "gezin", "Accept-Profile": "gezin" },
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
    },
    // [start (s), eind (s), €/kWh] per kwartier
    prijzen: (f.grid || []).map((p: number[]) => [p[0], p[1], rond(p[2], 4)]),
    injectie: (f.feedin || []).map((p: number[]) => [p[0], p[1], rond(p[2], 4)]),
    // [tijd (s), W] per kwartier
    zon: (f.solar?.timeseries || []).map((p: number[]) => [p[0], rond(p[1])]),
    zonKwh: { vandaag: rond((f.solar?.today?.energy || 0) / 1000, 1), morgen: rond((f.solar?.tomorrow?.energy || 0) / 1000, 1) },
  };
}

// Net en zon van vandaag per kwartier, uit de 5-minutenstatistieken van HA (websocket).
function historiek(): Promise<{ net: [number, number][]; zon: [number, number][] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(HA_URL.replace(/^http/, "ws") + "/api/websocket");
    const stop = setTimeout(() => { try { ws.close(); } catch { /* */ } reject(new Error("Home Assistant antwoordt niet")); }, 15000);
    const middernacht = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Brussels" }));
    const verschil = Date.now() - middernacht.getTime();
    middernacht.setHours(0, 0, 0, 0);
    const start = new Date(middernacht.getTime() + verschil);
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: HA_TOKEN }));
      else if (m.type === "auth_invalid") { clearTimeout(stop); ws.close(); reject(new Error("HA-token ongeldig")); }
      else if (m.type === "auth_ok") ws.send(JSON.stringify({ id: 1, type: "recorder/statistics_during_period", start_time: start.toISOString(), statistic_ids: [NET, ZON], period: "5minute", types: ["mean"] }));
      else if (m.id === 1) {
        clearTimeout(stop); ws.close();
        if (!m.success) return reject(new Error("Statistieken niet beschikbaar"));
        const perKwartier = (rijen: { start: number; mean: number }[] = []) => {
          const b = new Map<number, number[]>();
          for (const r of rijen) { const k = Math.floor(r.start / 900000) * 900; if (!b.has(k)) b.set(k, []); b.get(k)!.push(r.mean); }
          return [...b].map(([k, v]) => [k, Math.round(v.reduce((a, x) => a + x, 0) / v.length)] as [number, number]);
        };
        resolve({ net: perKwartier(m.result[NET]), zon: perKwartier(m.result[ZON]) });
      }
    };
    ws.onerror = () => { clearTimeout(stop); reject(new Error("Verbinding met Home Assistant mislukt")); };
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!HA_URL || !HA_TOKEN) return antwoord({ fout: "Home Assistant is nog niet ingesteld (HA_URL / HA_TOKEN)" }, 500);
    const auth = req.headers.get("Authorization") || "";
    const toegang = await rpc(auth, "energie_toegang");
    if (!toegang?.lezen) return antwoord({ fout: "Geen toegang tot de energiegegevens" }, 403);
    const { actie = "status", modus } = await req.json().catch(() => ({}));

    if (actie === "status") return antwoord({ ...(await evccStatus()), magSturen: !!toegang.sturen });
    if (actie === "historiek") return antwoord(await historiek());
    if (actie === "laadmodus") {
      if (!MODI.includes(modus)) return antwoord({ fout: "Onbekende laadmodus" }, 400);
      await rpc(auth, "energie_registreer", { p_actie: "laadmodus", p_waarde: modus });   // weigert tieners en kinderen
      await haDienst("kring_evcc_mode", { mode: modus });
      await new Promise((r) => setTimeout(r, 800));
      return antwoord({ ...(await evccStatus()), magSturen: true });
    }
    return antwoord({ fout: "Onbekende actie" }, 400);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return antwoord({ fout: m }, /toegang/i.test(m) ? 403 : 502);
  }
});
