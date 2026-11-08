// Kring – recept ophalen van een receptensite (15gram, Dagelijkse Kost, Colruyt, Libelle Lekker, …)
// Leest de gestructureerde receptdata (schema.org Recipe, JSON-LD) die deze sites in hun pagina zetten.
// Enkel voor aangemelde gezinsleden (JWT verplicht), één pagina per aanvraag, op vraag van de gebruiker.
// Deploy: supabase functions deploy recept-import   (verify_jwt staat standaard aan)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const antwoord = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function minuten(iso?: string): number | null {
  if (!iso) return null;
  const m = String(iso).match(/P(?:T)?(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m) return null;
  const t = (+(m[1] || 0)) * 60 + (+(m[2] || 0));
  return t || null;
}
function porties(y: unknown): number | null {
  const s = Array.isArray(y) ? y.join(" ") : String(y ?? "");
  const m = s.match(/\d+/);
  return m ? Math.min(40, +m[0]) : null;
}
function tekst(x: unknown): string {
  if (!x) return "";
  if (typeof x === "string") return x.replace(/<[^>]+>/g, "").trim();
  if (Array.isArray(x)) return x.map(tekst).filter(Boolean).join("\n\n");
  const o = x as Record<string, unknown>;
  if (o.itemListElement) return tekst(o.itemListElement);
  return tekst(o.text ?? o.name ?? "");
}
function zoekRecept(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const n of node) { const r = zoekRecept(n); if (r) return r; } return null; }
  const o = node as Record<string, unknown>;
  const t = o["@type"];
  if (t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"))) return o;
  return zoekRecept(o["@graph"]) ?? zoekRecept(o.mainEntity);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { url } = await req.json();
    let u: URL;
    try { u = new URL(url); } catch { return antwoord({ fout: "Ongeldige link" }, 400); }
    if (!/^https?:$/.test(u.protocol) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname))
      return antwoord({ fout: "Deze link kan niet opgehaald worden" }, 400);

    const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (Kring receptimport)", "Accept-Language": "nl-BE,nl" }, redirect: "follow" });
    if (!r.ok) return antwoord({ fout: `De site gaf fout ${r.status}. Plak de ingrediënten.` });
    const html = (await r.text()).slice(0, 3_000_000);

    let recept: Record<string, unknown> | null = null;
    for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try { recept = zoekRecept(JSON.parse(m[1].trim())); } catch { /* volgende */ }
      if (recept) break;
    }
    if (!recept) return antwoord({ fout: "Op deze pagina staat geen herkenbaar recept. Plak de ingrediënten." });

    return antwoord({
      naam: tekst(recept.name),
      omschrijving: tekst(recept.description).slice(0, 2000),
      porties: porties(recept.recipeYield),
      bereidingstijd_min: minuten(String(recept.totalTime ?? recept.cookTime ?? "")),
      ingredienten: (Array.isArray(recept.recipeIngredient) ? recept.recipeIngredient : []).map(tekst).filter(Boolean),
      bereiding: tekst(recept.recipeInstructions).slice(0, 20000),
      bron_url: u.toString(),
    });
  } catch (e) {
    return antwoord({ fout: "Ophalen mislukt: " + (e instanceof Error ? e.message : String(e)) }, 500);
  }
});
