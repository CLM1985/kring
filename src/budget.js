/* Kring – budget-rekenmotor (R4, lezen). Dezelfde regels als in de SQL-validatie op de YNAB-spiegel:
   - activiteit = som van transacties (en splitsingen) per categorie per maand, op budgetrekeningen
   - beschikbaar(m) = max(beschikbaar(m-1), 0) + toegewezen(m) + activiteit(m)      (negatief schuift niet door)
   - A(m) = Σ inkomen t/m m − Σ toegewezen t/m m + Σ overbesteding (negatief beschikbaar) t/m m-1
   - te verdelen(m) = A(m) ≥ 0 ? max(0, A(m) − toegewezen na m) : A(m) − toegewezen na m
   Bedragen in centen. Werkt in de browser (window.KringBudget) en in Node. */
(function (root) {
  "use strict";
  const mnd = d => d.slice(0, 7);
  const volgende = m => { const [y, k] = m.split("-").map(Number); return k === 12 ? `${y + 1}-01` : `${y}-${String(k + 1).padStart(2, "0")}`; };
  const reeks = (van, tot) => { const r = []; for (let m = van; m <= tot; m = volgende(m)) r.push(m); return r; };
  const RTA = "RTA";

  /** Regels per transactie (splitsingen apart). */
  function regels(transacties) {
    const out = [];
    for (const t of transacties) {
      if (t.splits && t.splits.length) t.splits.forEach(s => out.push({ ...t, bedrag: s.bedrag, categorie_id: s.categorie_id, memo: s.memo || t.memo, split: true }));
      else out.push(t);
    }
    return out;
  }

  function bereken(data, totMaand) {
    const opBudget = new Set(data.rekeningen.filter(r => r.op_budget).map(r => r.id));
    const cats = data.categorieen.map(c => c.id);
    const lijn = regels(data.transacties);
    const maanden0 = [...lijn.map(t => mnd(t.datum)), ...Object.keys(data.toewijzingen)].sort();
    const eerste = data.start ? volgende(data.start.maand) : maanden0[0], laatste = [totMaand, ...Object.keys(data.toewijzingen)].sort().pop();
    const maanden = reeks(eerste, laatste);
    const act = {}, inkomen = {};
    // Categorieën waarvan de activiteit niet uit transacties volgt (kredietkaartbetaling in YNAB): vaste waarden per maand
    const vast = new Set(data.categorieen.filter(c => c.activiteit_per_maand).map(c => c.id));
    for (const m of maanden) { act[m] = {}; inkomen[m] = 0; }
    for (const t of lijn) {
      if (!opBudget.has(t.rekening_id) || !t.categorie_id) continue;   // overboeking tussen budgetrekeningen: geen categorie
      const m = mnd(t.datum); if (!act[m]) continue;
      if (t.categorie_id === RTA) inkomen[m] += t.bedrag;
      else if (vast.has(t.categorie_id)) continue;
      else act[m][t.categorie_id] = (act[m][t.categorie_id] || 0) + t.bedrag;
    }
    for (const c of data.categorieen) if (c.activiteit_per_maand) for (const m of maanden) if (act[m]) act[m][c.id] = c.activiteit_per_maand[m] || 0;
    // Startpunt (bv. 24 maanden terug): beschikbaar per categorie en A uit de bron overnemen
    const res = {};
    let vorige = data.start ? Object.fromEntries(Object.entries(data.start.beschikbaar).map(([k, v]) => [k, { beschikbaar: v }])) : {};
    let cumA = data.start ? data.start.A : 0;
    let overPrev = data.start ? Object.entries(data.start.beschikbaar).filter(([k]) => !vast.has(k)).reduce((s, [, v]) => s + Math.min(0, v), 0) : 0;
    const toeTot = {}; let s = 0;
    for (const m of maanden.slice().reverse()) { toeTot[m] = s; s += Object.values(data.toewijzingen[m] || {}).reduce((a, b) => a + b, 0); }
    for (const m of maanden) {
      const toe = data.toewijzingen[m] || {};
      const rij = {}; let over = 0, somToe = 0, somAct = 0;
      for (const c of cats) {
        const t = toe[c] || 0, a = act[m][c] || 0, carry = vast.has(c) ? (vorige[c] ? vorige[c].beschikbaar : 0) : Math.max(vorige[c] ? vorige[c].beschikbaar : 0, 0);
        const b = carry + t + a;
        rij[c] = { toegewezen: t, activiteit: a, beschikbaar: b, overgedragen: carry };
        if (b < 0 && !vast.has(c)) over += b;
        somToe += t; somAct += a;
      }
      cumA += inkomen[m] - somToe + overPrev;
      const F = toeTot[m];
      res[m] = { cat: rij, inkomen: inkomen[m], toegewezen: somToe, activiteit: somAct, overbesteed: over, overbesteedVorige: overPrev,
                 A: cumA, toekomst: F, teVerdelen: cumA >= 0 ? Math.max(0, cumA - F) : cumA - F };
      overPrev = over; vorige = rij;
    }
    return { maanden, per: res };
  }

  /** Target: hoeveel moet er deze maand nog bij */
  function target(c, r, m) {
    const tg = c.target; if (!tg) return null;
    if (tg.type === "maand") { const nodig = Math.max(0, tg.bedrag - r.toegewezen); return { nodig, doel: tg.bedrag, voortgang: Math.min(1, r.toegewezen / tg.bedrag), label: `${(tg.bedrag / 100).toFixed(0)} per maand` }; }
    if (tg.type === "buffer") { const nodig = Math.max(0, tg.bedrag - r.beschikbaar); return { nodig, doel: tg.bedrag, voortgang: Math.max(0, Math.min(1, r.beschikbaar / tg.bedrag)), label: `buffer van ${(tg.bedrag / 100).toFixed(0)}` }; }
    if (tg.type === "datum") {
      const [y, k] = m.split("-").map(Number), [ty, tk] = tg.datum.split("-").map(Number);
      const rest = Math.max(1, (ty - y) * 12 + (tk - k) + 1);
      const perMaand = Math.ceil(Math.max(0, tg.bedrag - r.overgedragen) / rest);
      return { nodig: Math.max(0, perMaand - r.toegewezen), doel: tg.bedrag, voortgang: Math.max(0, Math.min(1, r.beschikbaar / tg.bedrag)), label: `${(tg.bedrag / 100).toFixed(0)} tegen ${tg.datum.slice(5, 7)}/${tg.datum.slice(0, 4)}` };
    }
    return null;
  }

  function saldi(data) {
    const s = {}; data.rekeningen.forEach(r => s[r.id] = { saldo: 0, gecleard: 0, open: 0 });
    for (const t of data.transacties) { const x = s[t.rekening_id]; if (!x) continue; x.saldo += t.bedrag; if (t.status === "u") x.open += t.bedrag; else x.gecleard += t.bedrag; }
    return s;
  }

  /* ---------- Testdata: een fictief Belgisch gezinsbudget (13 maanden) ---------- */
  function testdata(vandaag) {
    let zaad = 20261108; const rnd = () => (zaad = (zaad * 1103515245 + 12345) % 2147483648) / 2147483648;
    const rond = (a, b) => Math.round((a + rnd() * (b - a)) * 100);
    const groepen = [["vast", "Vaste lasten"], ["dag", "Dagelijks"], ["plezier", "Plezier"], ["doelen", "Sparen & doelen"]].map(([id, naam]) => ({ id, naam }));
    const C = (id, groep_id, naam, budget, target) => ({ id, groep_id, naam, budget: budget * 100, target });
    const categorieen = [
      C("lening", "vast", "Woonlening", 1150, { type: "maand", bedrag: 115000 }), C("energie", "vast", "Energie", 180, { type: "maand", bedrag: 18000 }),
      C("water", "vast", "Water", 35), C("internet", "vast", "Internet & gsm", 85), C("verzek", "vast", "Verzekeringen", 95, { type: "maand", bedrag: 9500 }),
      C("school", "vast", "School & opvang", 120),
      C("boodsch", "dag", "Boodschappen", 760, { type: "maand", bedrag: 76000 }), C("gezond", "dag", "Apotheek & dokter", 60), C("kleding", "dag", "Kleding", 120),
      C("kapper", "dag", "Kapper", 40), C("brandstof", "dag", "Brandstof", 160), C("auto", "dag", "Auto-onderhoud", 60, { type: "buffer", bedrag: 120000 }),
      C("uiteten", "plezier", "Uit eten", 150), C("sport", "plezier", "Vrije tijd & sport", 90), C("cadeaus", "plezier", "Cadeaus", 60), C("abo", "plezier", "Abonnementen", 35),
      C("vakantie", "doelen", "Vakantie", 250, { type: "datum", bedrag: 300000, datum: "2027-07" }), C("buffer", "doelen", "Buffer", 150, { type: "buffer", bedrag: 600000 }),
      C("auto2", "doelen", "Volgende auto", 200, { type: "maand", bedrag: 20000 })
    ];
    const rekeningen = [{ id: "zicht", naam: "Zichtrekening", type: "zicht", op_budget: true }, { id: "spaar", naam: "Spaarrekening", type: "spaar", op_budget: true },
      { id: "cash", naam: "Cash", type: "cash", op_budget: true }, { id: "lening-r", naam: "Woonlening", type: "tracking", op_budget: false }];
    const nu = new Date(vandaag + "T12:00:00"), mm = [];
    for (let i = 12; i >= 0; i--) { const d = new Date(nu.getFullYear(), nu.getMonth() - i, 1); mm.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); }
    const huidig = mm[mm.length - 1], dagNu = nu.getDate();
    const tx = []; let n = 0;
    const T = (m, dag, rek, bedrag, begunstigde, cat, extra = {}) => {
      if (m === huidig && dag > dagNu) return;
      tx.push({ id: "t" + (++n), rekening_id: rek, datum: `${m}-${String(Math.min(dag, 28)).padStart(2, "0")}`, bedrag, begunstigde, categorie_id: cat, memo: "", status: m === huidig && dag > dagNu - 3 ? "u" : "c", ...extra });
    };
    const voor = (() => { const d = new Date(nu.getFullYear(), nu.getMonth() - 13, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; })();
    tx.push({ id: "t0", rekening_id: "spaar", datum: `${voor}-28`, bedrag: 520000, begunstigde: "Beginsaldo", categorie_id: "RTA", memo: "", status: "c" });
    tx.push({ id: "t00", rekening_id: "zicht", datum: `${voor}-28`, bedrag: 180000, begunstigde: "Beginsaldo", categorie_id: "RTA", memo: "", status: "c" });
    tx.push({ id: "t000", rekening_id: "lening-r", datum: `${voor}-28`, bedrag: -16450000, begunstigde: "Beginsaldo", categorie_id: null, memo: "", status: "c" });
    const toewijzingen = {};
    mm.forEach((m, i) => {
      T(m, 25, "zicht", rond(2780, 2790), "Loon ouder 1", "RTA"); T(m, 26, "zicht", rond(2390, 2400), "Loon ouder 2", "RTA"); T(m, 9, "zicht", 18342, "Groeipakket", "RTA");
      T(m, 2, "zicht", -115000, "Woonlening", "lening", { transfer_rekening_id: "lening-r" }); T(m, 2, "lening-r", 76000, "Woonlening (aflossing)", null);
      T(m, 5, "zicht", -18000, "Engie", "energie"); T(m, 12, "zicht", -8499, "Proximus", "internet"); T(m, 14, "zicht", i % 3 === 0 ? -10500 : 0, "De Watergroep", "water");
      T(m, 8, "zicht", -9500, "Ethias", "verzek"); T(m, 15, "zicht", -rond(60, 180), "School", "school");
      [3, 10, 17, 24].forEach(d => T(m, d, "zicht", -rond(130, 230), "Colruyt", "boodsch")); [6, 20].forEach(d => T(m, d, "cash", -rond(8, 22), "Bakkerij", "boodsch"));
      T(m, 11, "zicht", -rond(10, 70), "Apotheek", "gezond"); if (i % 2) T(m, 18, "zicht", -rond(40, 190), "Zalando", "kleding");
      if (i % 2 === 0) T(m, 21, "zicht", -rond(28, 45), "Kapper", "kapper"); [7, 22].forEach(d => T(m, d, "zicht", -rond(65, 85), "Q8", "brandstof"));
      if (i === 5) T(m, 13, "zicht", -86420, "Garage", "auto");
      T(m, 19, "zicht", -rond(40, 120), "Restaurant", "uiteten"); T(m, 16, "zicht", -rond(30, 90), "Sportclub", "sport"); T(m, 4, "zicht", -3499, "Netflix & Spotify", "abo");
      if (i % 4 === 1) T(m, 23, "zicht", -rond(25, 80), "Cadeau", "cadeaus");
      if (i === 8) T(m, 10, "zicht", -184500, "Reisbureau", "vakantie");
      T(m, 27, "zicht", -60000, "Naar spaarrekening", null, { transfer_rekening_id: "spaar" }); T(m, 27, "spaar", 60000, "Van zichtrekening", null, { transfer_rekening_id: "zicht" });
      T(m, 1, "zicht", -10000, "Naar cash", null, { transfer_rekening_id: "cash" }); T(m, 1, "cash", 10000, "Geldautomaat", null, { transfer_rekening_id: "zicht" });
      toewijzingen[m] = Object.fromEntries(categorieen.map(c => [c.id, c.budget]));
      if (i === 11) toewijzingen[m].uiteten = 8000;          // vorige maand te weinig → overbesteding schuift niet door
    });
    // splitsing: grote Colruyt-aankoop deels kleding
    const sp = tx.find(t => t.begunstigde === "Colruyt" && t.datum.startsWith(mm[10]));
    if (sp) { sp.splits = [{ categorie_id: "boodsch", bedrag: sp.bedrag + 3500 }, { categorie_id: "kleding", bedrag: -3500, memo: "kousen" }]; sp.categorie_id = null; }
    // volgende maand al deels toegewezen
    toewijzingen[volgende(huidig)] = { lening: 115000, energie: 18000, verzek: 9500 };
    const data = { groepen, categorieen, rekeningen, transacties: tx.sort((a, b) => a.datum.localeCompare(b.datum)), toewijzingen, huidig };
    // overschot per maand naar de buffer, zodat er telkens een realistisch klein bedrag te verdelen blijft
    // (wie van het inkomen van vorige maand leeft: dat inkomen blijft staan voor de huidige maand)
    const somToe = m => Object.values(toewijzingen[m] || {}).reduce((a, b) => a + b, 0);
    const vorigeM = mm[mm.length - 2];
    for (const m of mm.slice(0, -1)) {
      const r = bereken(data, huidig).per[m];
      const doel = somToe(huidig) + somToe(volgende(huidig)) + 23540;   // één maand vooruit
      toewijzingen[m].buffer = Math.max(0, toewijzingen[m].buffer + r.A - doel);
    }
    return data;
  }

  const api = { bereken, target, saldi, regels, testdata, volgende, reeks, RTA };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.KringBudget = api;
})(typeof window !== "undefined" ? window : globalThis);
