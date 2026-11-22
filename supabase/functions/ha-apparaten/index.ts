// Kring – verbruik per apparaat: kWh per kwartier voor elk apparaat uit het energiedashboard van Home Assistant
// (Energie → Individuele apparaten, energy/get_prefs → device_consumption), voor vandaag of gisteren.
// Gebruikt op de energiepagina voor "Per apparaat" en "Waar ging de stroom naartoe?".
// Nieuwe meetstekkers (bv. de Shelly van het fornuis) verschijnen vanzelf zodra ze in HA bij Individuele apparaten staan.
//
// Geheimen: dezelfde als ha-energie (HA_URL, HA_TOKEN). Toegang: gezin.energie_toegang() met het JWT van de gebruiker.
// Deploy: supabase functions deploy ha-apparaten --no-verify-jwt (de functie controleert het JWT zelf, zoals ha-energie)
//
// Body: { dag?: "gisteren" } → { van, tot, apparaten: [{ id, naam, ouder, kwh: [[kwartier (s), kWh], …] }] }
//   ouder = included_in_stat: het apparaat zit al in een ander gemeten apparaat (niet dubbel tellen).

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

async function toegang(auth: string) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/energie_toegang`, {
    method: "POST",
    headers: { apikey: SB_ANON, Authorization: auth, "Content-Type": "application/json", "Content-Profile": "gezin", "Accept-Profile": "gezin" },
    body: "{}",
  });
  return r.ok ? await r.json() : null;
}

// Middernacht in België (Deno draait in UTC), zoals in ha-energie
function middernacht(dagen: number) {
  const lokaal = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Brussels" }));
  const verschil = Date.now() - lokaal.getTime();
  lokaal.setHours(0, 0, 0, 0); lokaal.setDate(lokaal.getDate() + dagen);
  return new Date(Math.round((lokaal.getTime() + verschil) / 900000) * 900000);
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

type StatRij = { start: number; change?: number | null };
type Apparaat = { id: string; naam: string; ouder: string | null; kwh: [number, number][] };

async function apparatenDag(gisteren: boolean) {
  const start = middernacht(gisteren ? -1 : 0), eind = gisteren ? middernacht(0) : new Date();
  const apparaten = await haSessie(async (vraag): Promise<Apparaat[]> => {
    const p = await vraag({ type: "energy/get_prefs" }) as { device_consumption?: { stat_consumption?: string; name?: string; included_in_stat?: string }[] };
    const lijst = (p?.device_consumption || []).filter((d) => typeof d.stat_consumption === "string" && d.stat_consumption);
    if (!lijst.length) return [];
    const ids = lijst.map((d) => d.stat_consumption!);
    const [stat, meta] = await Promise.all([
      vraag({ type: "recorder/statistics_during_period", start_time: start.toISOString(), end_time: eind.toISOString(), statistic_ids: ids, period: "5minute", types: ["change"], units: { energy: "kWh" } }) as Promise<Record<string, StatRij[]>>,
      (vraag({ type: "recorder/get_statistics_metadata", statistic_ids: ids }) as Promise<{ statistic_id: string; name?: string | null }[]>).catch(() => []),
    ]);
    const namen = new Map((meta || []).map((m) => [m.statistic_id, m.name || ""]));
    return lijst.map((d) => {
      const per = new Map<number, number>();
      for (const r of stat[d.stat_consumption!] || []) {
        // > 5 kWh per 5 minuten kan geen stekker zijn: tellerreset of opgeruimde historiek, geen meting
        if (typeof r.change !== "number" || !isFinite(r.change) || r.change < 0 || r.change > 5) continue;
        const k = Math.floor(Math.round(r.start / 1000) / 900) * 900;
        per.set(k, (per.get(k) || 0) + r.change);
      }
      return { id: d.stat_consumption!, naam: d.name || namen.get(d.stat_consumption!) || d.stat_consumption!, ouder: d.included_in_stat || null,
        kwh: [...per].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, Math.round(v * 10000) / 10000] as [number, number]) };
    });
  });
  return { van: start.getTime() / 1000, tot: eind.getTime() / 1000, apparaten };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!HA_URL || !HA_TOKEN) return antwoord({ fout: "Home Assistant is nog niet ingesteld (HA_URL / HA_TOKEN)" }, 500);
    const auth = req.headers.get("Authorization") || "";
    if (!/^Bearer \S+/.test(auth)) return antwoord({ fout: "Niet aangemeld" }, 401);
    const t = await toegang(auth);
    if (!t?.lezen) return antwoord({ fout: "Geen toegang tot de energiegegevens" }, 403);
    const body = await req.json().catch(() => ({}));
    return antwoord(await apparatenDag(body.dag === "gisteren"));
  } catch (e) {
    return antwoord({ fout: e instanceof Error ? e.message : String(e) }, 502);
  }
});
