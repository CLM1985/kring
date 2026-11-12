// Kring – service worker. Altijd eerst het netwerk (nieuwste versie), cache enkel als reserve zonder verbinding.
// Supabase en andere domeinen worden nooit aangeraakt of gecachet.
const CACHE = "kring-v3";
const GEDEELD = "kring-gedeeld"; // tijdelijke plek voor een gedeeld kasticket // verhogen bij grote wijzigingen om oude caches op te ruimen

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== GEDEELD).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const r = e.request;
  // Delen vanuit een andere app (bv. Xtra): Android stuurt de PDF als POST naar ./?deel=ticket
  if (r.method === "POST" && new URL(r.url).searchParams.get("deel") === "ticket") {
    e.respondWith((async () => {
      try {
        const f = (await r.formData()).get("ticket");
        if (f && f.size) {
          const c = await caches.open(GEDEELD);
          await c.put("gedeeld-ticket", new Response(f, { headers: {
            "Content-Type": f.type || "application/pdf",
            "X-Bestandsnaam": encodeURIComponent(f.name || "ticket.pdf") } }));
        }
      } catch (_) { /* app toont zelf een melding als er niets is */ }
      return Response.redirect(new URL("./?gedeeld=ticket#diepvries", self.registration.scope).href, 303);
    })());
    return;
  }
  if (r.method !== "GET" || new URL(r.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(r, { cache: "no-cache" })
      .then((res) => {
        if (res.ok) { const kopie = res.clone(); caches.open(CACHE).then((c) => c.put(r, kopie)); }
        return res;
      })
      .catch(() => caches.match(r, { ignoreSearch: true }).then((hit) => hit || (r.mode === "navigate"
        ? new Response(
            "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>" +
            "<body style='font:16px system-ui;padding:24px;background:#f3f5f2;color:#1d2a26'><h1>Geen verbinding</h1>" +
            "<p>Kring heeft internet nodig. Probeer het zo opnieuw.</p>",
            { headers: { "Content-Type": "text/html; charset=utf-8" } })
        : Response.error())))
  );
});
