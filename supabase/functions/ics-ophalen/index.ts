// Kring – externe agenda (ICS) ophalen voor een abonnement (school, sportclub, Google-agenda van iemand anders).
// De browser mag andere sites niet rechtstreeks lezen (CORS); deze functie haalt de .ics op voor aangemelde gezinsleden.
// Deploy: supabase functions deploy ics-ophalen   (verify_jwt staat standaard aan)
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const antwoord = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { url } = await req.json();
    let u: URL;
    try { u = new URL(String(url).replace(/^webcal:/i, "https:")); } catch { return antwoord({ fout: "Ongeldige link" }, 400); }
    if (u.protocol !== "https:" || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)) return antwoord({ fout: "Enkel https-links zijn toegelaten" }, 400);
    const r = await fetch(u, { headers: { "User-Agent": "Kring agenda", Accept: "text/calendar" }, redirect: "follow" });
    if (!r.ok) return antwoord({ fout: `De agenda gaf fout ${r.status}` });
    const ics = (await r.text()).slice(0, 5_000_000);
    if (!/BEGIN:VCALENDAR/.test(ics)) return antwoord({ fout: "Dit is geen ICS-agenda" });
    const naam = (ics.match(/^X-WR-CALNAME:(.+)$/m) || [])[1]?.trim() || u.hostname;
    return antwoord({ naam, ics });
  } catch (e) {
    return antwoord({ fout: "Ophalen mislukt: " + (e instanceof Error ? e.message : String(e)) }, 500);
  }
});
