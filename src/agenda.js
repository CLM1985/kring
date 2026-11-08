/* Kring – agendalogica: herhalingen uitrollen, Belgische feestdagen, Vlaamse schoolvakanties, ICS lezen.
   Datums zijn lokale kalenderdagen als "YYYY-MM-DD", tijden als "HH:MM" (Europe/Brussels).
   Werkt in de browser (window.KringAgenda) en in Node (module.exports). */
(function (root) {
  "use strict";
  const pad = n => String(n).padStart(2, "0");
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dag = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d, 12); };
  const plus = (s, n) => { const d = dag(s); d.setDate(d.getDate() + n); return iso(d); };
  const verschil = (a, b) => Math.round((dag(b) - dag(a)) / 864e5);
  const weekdag = s => (dag(s).getDay() + 6) % 7 + 1;          // 1 = maandag … 7 = zondag

  /* ---------- Herhaling ----------
     h = { freq: 'dag'|'week'|'maand'|'jaar', interval: 1, dagen: [1..7] (enkel week), tot: 'YYYY-MM-DD'|null }
     Geeft alle startdatums van een reeks die (met hun duur) overlappen met [van, tot]. */
  function voorkomens(start, duurDagen, h, van, tot, uitzonderingen) {
    const uit = new Set(uitzonderingen || []);
    const res = [];
    const ok = d => !uit.has(d) && d <= tot && plus(d, duurDagen) >= van;
    if (!h || !h.freq) { if (ok(start)) res.push(start); return res; }
    const n = Math.max(1, h.interval || 1);
    const einde = h.tot && h.tot < tot ? h.tot : tot;
    if (h.freq === "dag") {
      let d = start;
      const skip = Math.max(0, Math.floor((verschil(start, van) - duurDagen) / n));
      if (skip > 0) d = plus(start, skip * n);
      for (; d <= einde; d = plus(d, n)) if (ok(d)) res.push(d);
    } else if (h.freq === "week") {
      const dagen = (h.dagen && h.dagen.length ? h.dagen : [weekdag(start)]).slice().sort();
      let wk = plus(start, 1 - weekdag(start));                      // maandag van de startweek
      const skip = Math.max(0, Math.floor((verschil(wk, van) - 7 - duurDagen) / (7 * n)));
      if (skip > 0) wk = plus(wk, skip * 7 * n);
      for (; wk <= einde; wk = plus(wk, 7 * n))
        for (const wd of dagen) { const d = plus(wk, wd - 1); if (d >= start && d <= einde && ok(d)) res.push(d); }
    } else if (h.freq === "maand" || h.freq === "jaar") {
      const s = dag(start), stap = h.freq === "maand" ? n : 12 * n;
      for (let i = 0; ; i += stap) {
        const d = new Date(s.getFullYear(), s.getMonth() + i, 1, 12);
        const laatste = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        if (s.getDate() > laatste) continue;                         // 31e bestaat niet: overslaan (zoals Google)
        d.setDate(s.getDate());
        const ds = iso(d);
        if (ds > einde) break;
        if (ok(ds)) res.push(ds);
        if (i > 12 * 200) break;
      }
    }
    return res;
  }

  /** Rolt afspraken uit tot losse items per dag binnen [van, tot]. */
  function rolUit(afspraken, van, tot) {
    const out = [];
    for (const a of afspraken) {
      const duur = a.datum_tot ? Math.max(0, verschil(a.datum, a.datum_tot)) : 0;
      for (const d of voorkomens(a.datum, duur, a.herhaling, van, tot, a.uitzonderingen)) {
        for (let k = 0; k <= duur; k++) {
          const dd = plus(d, k);
          if (dd < van || dd > tot) continue;
          out.push({ ...a, voorkomen: d, dag: dd, eersteDag: k === 0, laatsteDag: k === duur, meerdaags: duur > 0 });
        }
      }
    }
    return out;
  }

  /* ---------- Belgische feestdagen ---------- */
  function pasen(j) {   // Meeus/Jones/Butcher
    const a = j % 19, b = Math.floor(j / 100), c = j % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
      g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
      l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
      maand = Math.floor((h + l - 7 * m + 114) / 31), dg = ((h + l - 7 * m + 114) % 31) + 1;
    return `${j}-${pad(maand)}-${pad(dg)}`;
  }
  function feestdagen(j) {
    const p = pasen(j);
    return [[`${j}-01-01`, "Nieuwjaar"], [p, "Pasen"], [plus(p, 1), "Paasmaandag"], [`${j}-05-01`, "Dag van de Arbeid"],
      [plus(p, 39), "O.L.H. Hemelvaart"], [plus(p, 49), "Pinksteren"], [plus(p, 50), "Pinkstermaandag"], [`${j}-07-11`, "Feest Vlaamse Gemeenschap"],
      [`${j}-07-21`, "Nationale feestdag"], [`${j}-08-15`, "O.L.V. Hemelvaart"], [`${j}-11-01`, "Allerheiligen"],
      [`${j}-11-11`, "Wapenstilstand"], [`${j}-12-25`, "Kerstmis"]].map(([datum, naam]) => ({ datum, naam }));
  }

  /* ---------- Vlaamse schoolvakanties (bron: vlaanderen.be, opgehaald 8/11/2026) ---------- */
  const SCHOOLVAKANTIES = [
    ["2025-10-27", "2025-11-02", "Herfstvakantie"], ["2025-12-22", "2026-01-04", "Kerstvakantie"],
    ["2026-02-16", "2026-02-22", "Krokusvakantie"], ["2026-04-06", "2026-04-19", "Paasvakantie"],
    ["2026-05-14", "2026-05-15", "Hemelvaart (vrij)"], ["2026-07-01", "2026-08-31", "Zomervakantie"],
    ["2026-11-02", "2026-11-08", "Herfstvakantie"], ["2026-12-21", "2027-01-03", "Kerstvakantie"],
    ["2027-02-08", "2027-02-14", "Krokusvakantie"], ["2027-03-29", "2027-04-11", "Paasvakantie"],
    ["2027-05-06", "2027-05-07", "Hemelvaart (vrij)"], ["2027-07-01", "2027-08-31", "Zomervakantie"]
  ].map(([datum, datum_tot, naam]) => ({ datum, datum_tot, naam }));

  /* ---------- Verjaardagen ---------- */
  function volgendeVerjaardag(v, vanaf) {
    const [, m, d] = v.datum.split("-").map(Number);
    let j = dag(vanaf).getFullYear();
    let ds = `${j}-${pad(m)}-${pad(d)}`;
    if (m === 2 && d === 29 && new Date(j, 1, 29).getMonth() !== 1) ds = `${j}-02-28`;
    if (ds < vanaf) { j++; ds = `${j}-${pad(m)}-${pad(d)}`; }
    const leeftijd = v.geboortejaar ? j - v.geboortejaar : null;
    return { datum: ds, leeftijd, dagen: verschil(vanaf, ds) };
  }

  /* ---------- ICS lezen (RFC 5545, de gangbare subset) ---------- */
  function leesICS(tekst) {
    const regels = tekst.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
    const ont = s => (s || "").replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
    const events = []; let e = null;
    const tijd = (waarde, params) => {
      const m = waarde.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
      if (!m) return null;
      if (!m[4] || /VALUE=DATE(?!-)/.test(params)) return { datum: `${m[1]}-${m[2]}-${m[3]}`, tijd: null };
      if (m[7]) { const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])); return { datum: iso(d), tijd: `${pad(d.getHours())}:${pad(d.getMinutes())}` }; }
      return { datum: `${m[1]}-${m[2]}-${m[3]}`, tijd: `${m[4]}:${m[5]}` };   // lokale tijd of TZID: als lokale tijd lezen
    };
    for (const r of regels) {
      if (r === "BEGIN:VEVENT") { e = { exdate: [] }; continue; }
      if (r === "END:VEVENT") { if (e && e.start) events.push(e); e = null; continue; }
      if (!e) continue;
      const i = r.indexOf(":"); if (i < 0) continue;
      const [naam, ...params] = r.slice(0, i).split(";"); const p = params.join(";"), w = r.slice(i + 1);
      if (naam === "SUMMARY") e.titel = ont(w);
      else if (naam === "LOCATION") e.plaats = ont(w);
      else if (naam === "DESCRIPTION") e.notitie = ont(w);
      else if (naam === "UID") e.uid = w;
      else if (naam === "DTSTART") e.start = tijd(w, p);
      else if (naam === "DTEND") e.einde = tijd(w, p);
      else if (naam === "RRULE") e.rrule = Object.fromEntries(w.split(";").map(x => x.split("=")));
      else if (naam === "EXDATE") w.split(",").forEach(x => { const t = tijd(x, p); if (t) e.exdate.push(t.datum); });
    }
    const FREQ = { DAILY: "dag", WEEKLY: "week", MONTHLY: "maand", YEARLY: "jaar" };
    const BYDAY = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };
    return events.map(e => {
      const heleDag = !e.start.tijd;
      let datum_tot = null;
      if (e.einde) { datum_tot = heleDag ? plus(e.einde.datum, -1) : e.einde.datum; if (datum_tot <= e.start.datum) datum_tot = null; }
      let herhaling = null, onvolledig = false;
      if (e.rrule && FREQ[e.rrule.FREQ]) {
        herhaling = { freq: FREQ[e.rrule.FREQ], interval: +(e.rrule.INTERVAL || 1), dagen: [], tot: null };
        if (e.rrule.BYDAY) {
          const d = e.rrule.BYDAY.split(",");
          if (herhaling.freq === "week" && d.every(x => BYDAY[x])) herhaling.dagen = d.map(x => BYDAY[x]);
          else onvolledig = true;                       // bv. "2e dinsdag van de maand": niet ondersteund
        }
        if (e.rrule.UNTIL) herhaling.tot = (tijd(e.rrule.UNTIL, "") || {}).datum || null;
        if (e.rrule.COUNT) { const v = voorkomens(e.start.datum, 0, herhaling, e.start.datum, "2100-12-31", []); herhaling.tot = v[Math.min(v.length, +e.rrule.COUNT) - 1] || null; }
      }
      return { ics_uid: e.uid || null, titel: e.titel || "(zonder titel)", datum: e.start.datum, datum_tot, hele_dag: heleDag,
        start_tijd: e.start.tijd, eind_tijd: e.einde && e.einde.tijd ? e.einde.tijd : null, plaats: e.plaats || "", notitie: e.notitie || "",
        herhaling, uitzonderingen: e.exdate, onvolledig };
    });
  }

  const api = { iso, dag, plus, verschil, weekdag, voorkomens, rolUit, pasen, feestdagen, SCHOOLVAKANTIES, volgendeVerjaardag, leesICS };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.KringAgenda = api;
})(typeof window !== "undefined" ? window : globalThis);
