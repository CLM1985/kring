// laadpaal-bewaking: stopt laadsessies met de CLM-laadpas (Radius) op de eigen laadpaal vóór ze 12 uur duren.
// Waarom: Radius rekent CLM een bezettingsvergoeding aan van € 1,80 excl. btw per begonnen uur boven 12 uur sessieduur
// (12 op 12 aanrekeningen mrt–nov 2026 volgen die regel). evcc op Uit pauzeert enkel het laden; de sessie loopt door.
// Een StopTransaction via het portaal van The Charge Grid (EVC-net) sluit de sessie af, ook als de kabel blijft hangen.
//
// Gestart door pg_cron (gezin.laadbewaking_start, elke 5 min). Regel:
//   kaart van CLM (RAD) én sessie ≥ STOP_NA_MIN minuten én al ≥ STIL_MIN minuten geen laadvermogen → StopTransaction.
//   Laadt de wagen dan nog: niet stoppen, één melding in gezin.laadbewaking_log.
// Secrets: EVCNET_EMAIL, EVCNET_PASSWORD (zelfde als evcnet-sync), HA_URL en HA_TOKEN (zelfde als ha-energie). Toegang: x-sync-secret = Vault evcnet_sync_secret.
// Herkenning (stap 2 laadregels per wagen): elke controle bewaart de wagen per sessie in gezin.laadsessie_wagen
// (public.laadsessie_wagen_zien); controle tegen EVC-net in gezin.v_laadsessie_wagen_controle.
// Sturing (stap 4, sinds 22/11/2026): voor een herkende wagen met regel_actief zet de bewaking evcc op now/smart/off volgens
// gezin.laadplan (zon eerst, dan de goedkoopste kwartieren tot het doel). Manuele wijziging of knop in Kring = overrule voor de sessie.
// ?test=1 → enkel het overzicht van de laadpaal tonen, niets loggen of stoppen.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const BASE = (Deno.env.get("EVCNET_BASE_URL") ?? "https://thechargegrid.evc-net.com").replace(/\/$/, "");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const LAADPUNT = "1234657482";
const KAART_CLM = /RAD|354108/i;      // BE-RAD-354108-2 (laadpas CLM via Radius)
const STOP_NA_MIN = 11 * 60 + 40;      // 11 u 40
const STIL_MIN = 10;                   // zolang al niet meer geladen
const HANDLER = "\\LMS\\EV\\AsyncServices\\RechargeSpotsAsyncService";
// Laadvermogen: het portaal laat MOM_POWER_KW soms op een oude waarde staan. Bron = evcc via Home Assistant
// (sensor.wagen_laadvermogen, W); het portaal enkel als HA niet antwoordt.
const HA_URL = (Deno.env.get("HA_URL") || "").replace(/\/+$/, ""), HA_TOKEN = Deno.env.get("HA_TOKEN") || "";
async function haVermogenKw(): Promise<number | null> {
  if (!HA_URL || !HA_TOKEN) return null;
  try {
    const r = await fetch(`${HA_URL}/api/states/sensor.wagen_laadvermogen`, { headers: { Authorization: `Bearer ${HA_TOKEN}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const v = parseFloat((await r.json()).state);
    return isFinite(v) ? v / 1000 : null;
  } catch { return null; }
}

// Stap 4 laadregels per wagen: evcc sturen via de rest_commands van Kring in HA (kring_evcc_state/mode/alwayscharge).
async function haDienst(dienst: string, data: Record<string, unknown> = {}) {
  if (!HA_URL || !HA_TOKEN) throw new Error("HA_URL / HA_TOKEN ontbreken");
  const r = await fetch(`${HA_URL}/api/services/rest_command/${dienst}?return_response`, {
    method: "POST", headers: { Authorization: `Bearer ${HA_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(data), signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`HA ${dienst}: HTTP ${r.status}`);
  const resp = (await r.json()).service_response || {};
  if (resp.status && resp.status >= 400) throw new Error(`evcc ${dienst}: ${resp.status}`);
  return resp.content;
}
// Beslissing uit gezin.laadplan (via public.laadsturing): now | smart | off, altijd laden uit.
// Staat evcc anders dan wat de regel laatst zette, dan heeft iemand manueel ingegrepen → overrule voor de rest van de sessie.
async function haSensor(id: string | null) {
  if (!id || !/^sensor\.[a-z0-9_]+$/.test(id) || !HA_URL || !HA_TOKEN) return null;
  try {
    const r = await fetch(`${HA_URL}/api/states/${id}`, { headers: { Authorization: `Bearer ${HA_TOKEN}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const v = parseFloat((await r.json()).state);
    return isFinite(v) && v > 0 && v <= 100 ? v : null;
  } catch { return null; }
}
async function sturen(sb: ReturnType<typeof createClient>, sessie: number, kw: number, log: (r: Record<string, unknown>) => unknown, basis: Record<string, unknown>) {
  const c = await haDienst("kring_evcc_state");
  const lp = ((c?.result || c || {}).loadpoints || [])[0] || {};
  // batterij%: evcc, anders de HA-sensor van de wagen (gezin.wagens.soc_sensor; de Audi geeft via evcc geen %)
  let soc = typeof lp.vehicleSoc === "number" && lp.vehicleSoc > 0 ? lp.vehicleSoc : null;
  if (soc == null) { const { data: sensor } = await sb.rpc("laadsessie_soc_sensor", { p_sessie: sessie }); soc = await haSensor(sensor ?? null); }
  const altijd = lp.alwaysCharge === true || lp.alwaysCharge === "on";   // evcc geeft "on" | "off" | "once"
  const { data: b, error } = await sb.rpc("laadsturing", { p_sessie: sessie, p_soc: soc, p_evcc_modus: lp.mode ?? null, p_evcc_altijd: altijd, p_kw: kw });
  if (error) throw new Error("laadsturing: " + error.message);
  if (b?.override) await log({ ...basis, actie: "overrule", detail: b.reden });
  if (b?.vol) await log({ ...basis, actie: "melding", detail: `${b.wagen}: laadt niet meer op Snel → als vol beschouwd · soc ${soc ?? "?"}` });
  if (!b?.modus) return b;
  if (b.doen) {
    if (altijd) await haDienst("kring_evcc_alwayscharge", { waarde: "off" });
    if (lp.mode !== b.modus) await haDienst("kring_evcc_mode", { mode: b.modus });
    await log({ ...basis, actie: "sturing", detail: `${b.wagen}: ${lp.mode}${altijd ? " + altijd laden" : ""} → ${b.modus} · ${b.reden} · soc ${soc ?? "?"}`.slice(0, 500) });
  }
  await sb.rpc("laadsturing_gezet", { p_sessie: sessie, p_modus: b.modus, p_altijd: false });
  return b;
}

class Jar {
  c = new Map<string, string>();
  take(r: Response) {
    for (const sc of r.headers.getSetCookie()) {
      const [kv] = sc.split(";");
      const i = kv.indexOf("=");
      if (i > 0) this.c.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join("; "); }
}
async function req(jar: Jar, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", UA);
  headers.set("Cookie", jar.header());
  const r = await fetch(path.startsWith("http") ? path : BASE + path, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(20000) });
  jar.take(r);
  return r;
}
async function login(jar: Jar) {
  const email = Deno.env.get("EVCNET_EMAIL"), pw = Deno.env.get("EVCNET_PASSWORD");
  if (!email || !pw) throw new Error("Secrets EVCNET_EMAIL / EVCNET_PASSWORD ontbreken");
  await (await req(jar, "/Login/Login")).text();
  const r = await req(jar, "/Login/Login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE, Referer: BASE + "/Login/Login" },
    body: new URLSearchParams({ emailField: email, passwordField: pw, Login: "Login" }),
  });
  await r.text();
  const loc = r.headers.get("location") ?? "";
  if (r.status !== 302 || /login|otp|verif|code/i.test(loc)) throw new Error(`Login EVC-net mislukt (HTTP ${r.status})`);
}
async function ajax(jar: Jar, method: string, params: Record<string, unknown>) {
  const q = new URLSearchParams({ requests: JSON.stringify({ "0": { handler: HANDLER, method, params } }), metricKey: "RechargeSpotDashboard_1021" });
  const r = await req(jar, `/api/ajax?${q}`, { headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json", Referer: `${BASE}/RechargeSpots/Detail/${LAADPUNT}` } });
  const t = await r.text();
  if (r.status !== 200) throw new Error(`${method}: HTTP ${r.status} ${t.slice(0, 150)}`);
  try { return JSON.parse(t); } catch { throw new Error(`${method}: geen JSON (${t.slice(0, 150)})`); }
}
type Kanaal = { CHANNEL?: string; MOM_POWER_KW?: number; TRANS_ENERGY_DELIVERED_KWH?: unknown; TRANSACTION_TIME_H_M?: unknown; CARDID?: unknown; CARDS_IDX?: unknown; CUSTOMER_NAME?: string; STATUS?: string; NOTIFICATION?: string };
const minuten = (x: unknown) => {
  if (x == null) return null;
  const s = String(x), m = s.match(/(\d+)\D+(\d+)/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = Number(s);
  return isFinite(n) && s.trim() !== "" ? n : null;
};

Deno.serve(async (request) => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: geheim } = await sb.rpc("evcnet_sync_secret");
  if (!geheim || request.headers.get("x-sync-secret") !== geheim) return new Response("forbidden", { status: 403 });
  const test = new URL(request.url).searchParams.get("test") === "1";
  const log = (rij: Record<string, unknown>) => sb.rpc("laadbewaking_log", { p_rij: rij });
  try {
    const jar = new Jar();
    await login(jar);
    const ov = await ajax(jar, "overview", { rechargeSpotId: LAADPUNT });
    const kanalen: Kanaal[] = (Array.isArray(ov) ? ov.flat(2) : []).filter((x: unknown) => x && typeof x === "object");
    if (test) return Response.json({ ok: true, test: true, kanalen, ha_kw: await haVermogenKw() });
    const uit = [];
    for (const k of kanalen) {
      const minPortaal = minuten(k.TRANSACTION_TIME_H_M);
      if (minPortaal == null) continue;                            // geen lopende sessie
      const kaart = [k.CARDID, k.CARDS_IDX, k.CUSTOMER_NAME].map((x) => (x == null ? "" : typeof x === "object" ? JSON.stringify(x) : String(x))).join(" ").trim();
      const nu = Date.now(), startPortaal = new Date(Math.round((nu - minPortaal * 60000) / 300000) * 300000).toISOString();
      const ha = await haVermogenKw();
      const kw = ha ?? (Number(k.MOM_POWER_KW) || 0), kwh = Number(k.TRANS_ENERGY_DELIVERED_KWH) || null;
      const clm = KAART_CLM.test(kaart);
      // Het portaal laat TRANSACTION_TIME_H_M op 00:00 staan (vastgesteld 22/11/2026). De duur komt daarom uit de eigen
      // registratie: start = eerste keer dat de bewaking deze kaart zag (sessie = doorlopend gezien, gat < 15 min).
      // Stap 2 laadregels per wagen: wagen herkennen aan de kaart en per sessie bewaren (stuurt nog niets)
      const { data: herk } = await sb.rpc("laadsessie_wagen_zien", { p_kaart: kaart || "(onbekend)", p_sessie_start: startPortaal, p_kwh: kwh, p_uur: Math.round(minPortaal / 6) / 10 });
      const wagen = herk?.wagen ?? "niet herkend";
      const min = Math.max(minPortaal, Number(herk?.minuten) || 0);
      const start = herk?.sessie_start ? new Date(herk.sessie_start).toISOString() : startPortaal;
      const basis = { sessie_start: start, kaart: kaart || "(onbekend)", sessie_uur: Math.round(min / 6) / 10, vermogen_kw: kw, energie_kwh: kwh };
      // Elke sessie loggen (ook andere kaarten), zodat zichtbaar is of de kaart van CLM herkend wordt
      await log({ ...basis, actie: "controle", detail: `${wagen} · ${clm ? "CLM" : "andere kaart"} · ${k.NOTIFICATION ?? ""} · bron ${ha == null ? "portaal" : "evcc"} · tijd ${String(k.TRANSACTION_TIME_H_M)}` });
      // Stap 4: de regel van de herkende wagen stuurt evcc (enkel als regel_actief en geen overrule)
      if (herk?.id) {
        try { const b = await sturen(sb, herk.id, kw, log, basis); uit.push({ kanaal: k.CHANNEL, sturing: b?.modus ?? null, reden: b?.reden ?? null }); }
        catch (e) { await log({ ...basis, actie: "fout", detail: ("sturing: " + (e instanceof Error ? e.message : String(e))).slice(0, 500) }); }
      }
      if (!clm) { uit.push({ kanaal: k.CHANNEL, kaart, min, actie: "andere kaart" }); continue; }
      if (min < STOP_NA_MIN) { uit.push({ kanaal: k.CHANNEL, min, kw, actie: "wacht" }); continue; }
      const { data: s } = await sb.rpc("laadbewaking_sessie", { p_sessie_start: start });
      if (s?.gestopt > 0) { uit.push({ kanaal: k.CHANNEL, min, actie: "al gestopt" }); continue; }
      const stilSinds = s?.laatst_laden ?? s?.eerste;
      const stil = kw <= 0.1 && stilSinds && nu - Date.parse(stilSinds) >= STIL_MIN * 60000;
      if (!stil) {
        if (!(s?.gemeld > 0)) await log({ ...basis, actie: "melding", detail: kw > 0.1 ? "Laadt nog na 11 u 40: niet gestopt" : "Nog geen 10 min stil: volgende controle" });
        uit.push({ kanaal: k.CHANNEL, min, kw, actie: "niet gestopt" });
        continue;
      }
      const r = await ajax(jar, "action", { action: "StopTransaction", rechargeSpotId: LAADPUNT, clickedButtonId: 0, channel: String(k.CHANNEL ?? "1") });
      await log({ ...basis, actie: "gestopt", detail: JSON.stringify(r).slice(0, 500) });
      uit.push({ kanaal: k.CHANNEL, min, actie: "gestopt" });
    }
    return Response.json({ ok: true, uit });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!test) await log({ actie: "fout", detail: msg.slice(0, 500) });
    return Response.json({ ok: false, fout: msg }, { status: 500 });
  }
});
