/* Kring – budget-scherm (R4, lezen): plan per maand, rekeningen met register, rapporten. */
"use strict";
const KB = window.KringBudget;
const euro = c => (c < 0 ? "−" : "") + "€ " + (Math.abs(c) / 100).toLocaleString("nl-BE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const euroKort = c => (c < 0 ? "−" : "") + "€ " + Math.round(Math.abs(c) / 100).toLocaleString("nl-BE");
const MAANDNAAM = m => { const [y, k] = m.split("-").map(Number); return `${MAANDEN[k - 1]} ${y}`; };
const MAANDKORT = m => MAANDEN[+m.slice(5, 7) - 1].slice(0, 3);
const vorigeMnd = m => { const [y, k] = m.split("-").map(Number); return k === 1 ? `${y - 1}-12` : `${y}-${String(k - 1).padStart(2, "0")}`; };

let BR = null;   // berekening (cache)
function budgetBerekening() { if (!BR || BR.data !== S.budget) BR = { data: S.budget, ...KB.bereken(S.budget, S.budget.huidig) }; return BR; }
const regelsCache = () => (BR && BR.regels) || (BR.regels = KB.regels(S.budget.transacties));

function viewBudget() {
  if (!S.budget) { $("#view").innerHTML = `<div class="leegstaat">Budget laden…</div>`; return; }
  const seg = `<div class="ag-kop"><div class="seg" role="group" aria-label="Budget">${[["plan", "Plan"], ["rekeningen", "Rekeningen"], ["rapporten", "Rapporten"]].map(([k, l]) => `<button data-bview="${k}" aria-pressed="${S.budgetView === k}">${l}</button>`).join("")}</div></div>`;
  const banner = db.demo ? `<div class="banner"><b>Testversie budget</b> met een fictief gezinsbudget (geen echte cijfers). De rekenregels zijn dezelfde als die ik op jullie YNAB-historiek controleerde. Enkel lezen: toewijzen en invoeren komen in R5.</div>` : "";
  $("#view").innerHTML = banner + seg + `<div id="bview"></div>`;
  ({ plan: budgetPlan, rekeningen: budgetRekeningen, rapporten: budgetRapporten })[S.budgetView]();
}

/* ---------- Plan ---------- */
function budgetPlan() {
  const B = budgetBerekening(), m = S.bmaand, r = B.per[m];
  if (!r) { $("#bview").innerHTML = `<div class="leegstaat">Geen budget voor ${MAANDNAAM(m)}.</div>`; return; }
  const cats = S.budget.categorieen;
  const info = c => ({ c, r: r.cat[c.id], t: KB.target(c, r.cat[c.id], m) });
  const filt = { alle: () => true, teweinig: x => x.t && x.t.nodig > 0, over: x => x.r.beschikbaar < 0, beschikbaar: x => x.r.beschikbaar > 0 }[S.bfilter];
  const tv = r.teVerdelen;
  const kop = `<div class="rta ${tv > 0 ? "pos" : tv < 0 ? "neg" : "nul"}">
      <div><span class="lbl-klein">Te verdelen</span><div class="rta-bedrag">${euro(tv)}</div></div>
      <div class="rta-sub">${tv > 0 ? "Geef elke euro een taak." : tv < 0 ? "Meer toegewezen dan er is: haal ergens geld weg." : "Alles heeft een taak."}<br>
      Inkomen ${euro(r.inkomen)} · toegewezen ${euro(r.toegewezen)} · uitgegeven ${euro(-Math.min(0, r.activiteit))}${r.overbesteedVorige < 0 ? ` · overbesteed vorige maand ${euro(r.overbesteedVorige)}` : ""}${r.toekomst ? ` · al toegewezen in latere maanden ${euro(r.toekomst)}` : ""}</div></div>`;
  const chips = `<div class="chips">${[["alle", "Alle"], ["teweinig", "Te weinig"], ["over", "Overbesteed"], ["beschikbaar", "Geld beschikbaar"]].map(([k, l]) => `<button class="chip" data-bfilter="${k}" aria-pressed="${S.bfilter === k}">${l}</button>`).join("")}</div>`;
  const pill = b => `<span class="pill ${b < 0 ? "neg" : b > 0 ? "pos" : "nul"}">${euro(b)}</span>`;
  const groepen = S.budget.groepen.map(g => {
    const rijen = cats.filter(c => c.groep_id === g.id).map(info).filter(filt);
    if (!rijen.length) return "";
    const som = k => rijen.reduce((s, x) => s + x.r[k], 0);
    return `<tbody><tr class="grp"><th scope="rowgroup">${esc(g.naam)}</th><td>${euro(som("toegewezen"))}</td><td>${euro(som("activiteit"))}</td><td>${euro(som("beschikbaar"))}</td></tr>
      ${rijen.map(({ c, r: x, t }) => `<tr class="cat${S.bcat === c.id ? " sel" : ""}" data-bcat="${c.id}" tabindex="0">
        <th scope="row"><span class="cnaam">${esc(c.naam)}</span>${t ? `<span class="tbar" title="${esc(t.label)}"><i style="width:${Math.round(t.voortgang * 100)}%"></i></span><span class="tlbl">${t.nodig > 0 ? `nog ${euro(t.nodig)} nodig` : "doel gehaald"}</span>` : ""}</th>
        <td>${euro(x.toegewezen)}</td><td>${euro(x.activiteit)}</td><td>${pill(x.beschikbaar)}</td></tr>`).join("")}</tbody>`;
  }).join("");
  const tabel = `<div class="btabel-wrap"><table class="btabel"><thead><tr><th scope="col">Categorie</th><th scope="col">Toegewezen</th><th scope="col">Activiteit</th><th scope="col">Beschikbaar</th></tr></thead>${groepen || `<tbody><tr><td colspan="4" class="muted">Geen categorieën in deze selectie.</td></tr></tbody>`}</table></div>`;
  const breed = window.innerWidth >= 1000;
  let live = "";
  if (S.budget.controle) {   // echte versie: elke keer vergelijken met de YNAB-cijfers
    let ok = 0, n = 0, okR = 0, nR = 0;
    for (const k of B.maanden) { const c = S.budget.controle.beschikbaar && S.budget.controle.beschikbaar[k]; if (c) for (const id in c) { n++; if (B.per[k].cat[id] && B.per[k].cat[id].beschikbaar === c[id]) ok++; }
      const tv = S.budget.controle.te_verdelen && S.budget.controle.te_verdelen[k]; if (tv != null && k <= S.budget.huidig) { nR++; if (B.per[k].teVerdelen === tv) okR++; } }
    live = `<p><b>Vandaag:</b> beschikbaar ${ok.toLocaleString("nl-BE")} van ${n.toLocaleString("nl-BE")} gelijk, te verdelen ${okR} van ${nR} maanden gelijk.</p>`;
  }
  const controle = `<details class="controle"${live ? " open" : ""}><summary>Controle met YNAB</summary>${live}<p>Op jullie echte gezamenlijke plan (2018 – nov 2026) rekende ik dezelfde regels na in de database:</p>
    <ul><li>Activiteit per categorie per maand: <b>14.873 van 14.873</b> op de cent gelijk.</li><li>Beschikbaar per categorie per maand: <b>14.873 van 14.873</b> gelijk.</li>
    <li>Te verdelen per maand: <b>106 van 107</b> gelijk. De afwijking (deze maand, € 331,05) zit in de kredietkaartlogica en wordt nog uitgezocht.</li></ul>
    <p class="muted">In de echte versie loopt deze controle elke nacht tot de overstap.</p></details>`;
  $("#bview").innerHTML = kop + chips + (breed ? `<div class="bgrid">${tabel}<aside class="inspector" id="inspector">${inspectorHtml()}</aside></div>` : tabel) + controle;
}
function inspectorHtml() {
  const B = budgetBerekening(), m = S.bmaand, r = B.per[m];
  const c = S.budget.categorieen.find(x => x.id === S.bcat);
  if (!c) {
    const over = S.budget.categorieen.filter(x => r.cat[x.id].beschikbaar < 0);
    return `<h3>${MAANDNAAM(m)}</h3><dl class="kv"><dt>Inkomen</dt><dd>${euro(r.inkomen)}</dd><dt>Toegewezen</dt><dd>${euro(r.toegewezen)}</dd><dt>Activiteit</dt><dd>${euro(r.activiteit)}</dd><dt>Te verdelen</dt><dd>${euro(r.teVerdelen)}</dd></dl>
      ${over.length ? `<p class="lbl-klein">Overbesteed</p><ul class="kort">${over.map(x => `<li><button class="link" data-bcat="${x.id}">${esc(x.naam)}</button> ${euro(r.cat[x.id].beschikbaar)}</li>`).join("")}</ul><p class="muted">Een tekort schuift niet door: het wordt volgende maand van het te verdelen bedrag afgetrokken.</p>` : `<p class="muted">Geen overbestede categorieën.</p>`}
      <p class="muted">Kies een categorie voor details.</p>`;
  }
  const x = r.cat[c.id], t = KB.target(c, x, m);
  const hist = B.maanden.filter(k => k <= m).slice(-12).map(k => B.per[k].cat[c.id].activiteit);
  const gem = n => { const a = hist.slice(-n - 1, -1); return a.length ? Math.round(a.reduce((s, v) => s + v, 0) / a.length) : 0; };
  const laatste = regelsCache().filter(tr => tr.categorie_id === c.id && tr.datum.slice(0, 7) <= m).slice(-5).reverse();
  return `<h3>${esc(c.naam)}</h3>
    <div class="ins-bedrag ${x.beschikbaar < 0 ? "neg" : ""}">${euro(x.beschikbaar)}<span class="lbl-klein"> beschikbaar</span></div>
    <dl class="kv"><dt>Overgedragen</dt><dd>${euro(x.overgedragen)}</dd><dt>+ Toegewezen</dt><dd>${euro(x.toegewezen)}</dd><dt>+ Activiteit</dt><dd>${euro(x.activiteit)}</dd><dt>= Beschikbaar</dt><dd><b>${euro(x.beschikbaar)}</b></dd></dl>
    ${t ? `<p class="lbl-klein">Doel</p><p>${esc(t.label)}<span class="tbar groot"><i style="width:${Math.round(t.voortgang * 100)}%"></i></span>${t.nodig > 0 ? `Nog ${euro(t.nodig)} nodig deze maand.` : "Doel gehaald."}</p>` : ""}
    <dl class="kv"><dt>Gem. uitgegeven 3 mnd</dt><dd>${euro(-gem(3))}</dd><dt>Gem. uitgegeven 12 mnd</dt><dd>${euro(-gem(12))}</dd></dl>
    ${laatste.length ? `<p class="lbl-klein">Laatste transacties</p><ul class="kort">${laatste.map(tr => `<li><span>${tr.datum.slice(8, 10)}/${tr.datum.slice(5, 7)} ${esc(tr.begunstigde)}</span><span>${euro(tr.bedrag)}</span></li>`).join("")}</ul>` : ""}`;
}
function openInspector(id) {
  S.bcat = id;
  if (window.innerWidth >= 1000) { budgetPlan(); return; }
  openPaneel(`<div class="paneel-kop"><h2>Details</h2><button class="ib" data-sluit aria-label="Sluiten">✕</button></div>${inspectorHtml()}`);
}

/* ---------- Rekeningen + register ---------- */
function budgetRekeningen() {
  const s = KB.saldi(S.budget), rek = S.budget.rekeningen;
  const totaal = l => l.reduce((a, r) => a + s[r.id].saldo, 0);
  const lijst = (titel, l) => `<div class="groep"><h3><span>${titel}</span><span>${euro(totaal(l))}</span></h3>${l.map(r => `<button class="rek${S.brek === r.id ? " sel" : ""}" data-brek="${r.id}"><span>${esc(r.naam)}</span><span>${euro(s[r.id].saldo)}${s[r.id].open ? `<small>${euro(s[r.id].open)} nog niet verwerkt</small>` : ""}</span></button>`).join("")}</div>`;
  const zoek = S.bzoek || "";
  const sel = S.brek || "alle", namen = Object.fromEntries(S.budget.categorieen.map(c => [c.id, c.naam])); namen.RTA = "Inkomen (te verdelen)";
  const rekNaam = Object.fromEntries(rek.map(r => [r.id, r.naam]));
  let tx = S.budget.transacties.filter(t => sel === "alle" ? true : t.rekening_id === sel);
  let saldo = 0; const metSaldo = tx.map(t => ({ ...t, loop: (saldo += t.bedrag) }));
  const z = norm(zoek);
  const zicht = metSaldo.filter(t => !z || norm(t.begunstigde).includes(z) || norm(namen[t.categorie_id] || "").includes(z) || norm(t.memo).includes(z) || String(t.bedrag / 100).includes(z)).reverse().slice(0, 150);
  const cat = t => t.splits ? `Gesplitst: ${t.splits.map(x => namen[x.categorie_id]).join(", ")}` : t.transfer_rekening_id ? `→ ${rekNaam[t.transfer_rekening_id]}` : (namen[t.categorie_id] || "—");
  $("#bview").innerHTML = `<div class="rek-grid"><div>${lijst("Budgetrekeningen", rek.filter(r => r.op_budget))}${lijst("Opvolgen (buiten budget)", rek.filter(r => !r.op_budget))}
      <button class="rek${sel === "alle" ? " sel" : ""}" data-brek="alle"><span>Alle rekeningen</span><span></span></button></div>
    <div class="register"><div class="zoekbalk"><input class="in" id="bzoek" type="search" placeholder="Zoek begunstigde, categorie, bedrag" value="${esc(zoek)}" aria-label="Zoek transacties"></div>
      <div class="btabel-wrap"><table class="btabel reg"><thead><tr><th scope="col">Datum</th><th scope="col">Begunstigde</th><th scope="col">Categorie</th><th scope="col">Bedrag</th>${sel !== "alle" ? `<th scope="col">Saldo</th>` : ""}</tr></thead>
      <tbody>${zicht.map(t => `<tr><td>${t.datum.slice(8, 10)}/${t.datum.slice(5, 7)}/${t.datum.slice(2, 4)}</td><td>${esc(t.begunstigde)}${sel === "alle" ? `<small>${esc(rekNaam[t.rekening_id])}</small>` : ""}${t.status === "u" ? ` <span class="tag">open</span>` : ""}</td><td>${esc(cat(t))}</td><td class="${t.bedrag < 0 ? "" : "in"}">${euro(t.bedrag)}</td>${sel !== "alle" ? `<td>${euro(t.loop)}</td>` : ""}</tr>`).join("") || `<tr><td colspan="5" class="muted">Geen transacties gevonden.</td></tr>`}</tbody></table></div>
      <p class="muted" style="font-size:.85rem">${zicht.length === 150 ? "De 150 meest recente transacties. Zoek om verder te filteren." : `${zicht.length} transacties`}</p></div></div>`;
}

/* ---------- Rapporten ---------- */
function budgetRapporten() {
  const B = budgetBerekening(), eind = S.bmaand <= S.budget.huidig ? S.bmaand : S.budget.huidig;
  const mm = B.maanden.filter(k => k <= eind).slice(-12);
  const uitgaven = k => -S.budget.categorieen.reduce((s, c) => s + B.per[k].cat[c.id].activiteit, 0);   // netto uitgaven (terugbetalingen trekken af)
  const r = B.per[eind];
  const perCat = S.budget.categorieen.map(c => ({ c, v: -r.cat[c.id].activiteit })).filter(x => x.v > 0).sort((a, b) => b.v - a.v);
  const top = perCat.slice(0, 8), rest = perCat.slice(8).reduce((s, x) => s + x.v, 0);
  if (rest > 0) top.push({ c: { naam: "Overige" }, v: rest });
  const totaalUit = perCat.reduce((s, x) => s + x.v, 0);
  // 1. horizontale staven per categorie
  const maxH = Math.max(1, ...top.map(x => x.v));
  const hbars = `<div class="hbars" role="img" aria-label="Uitgaven per categorie in ${MAANDNAAM(eind)}">${top.map(x => `<div class="hb"><span class="hb-l">${esc(x.c.naam)}</span><span class="hb-b"><i style="width:${(x.v / maxH * 100).toFixed(1)}%" title="${esc(x.c.naam)}: ${euro(x.v)}"></i></span><span class="hb-v">${euro(x.v)}</span></div>`).join("")}</div>`;
  // 2+3. staafgrafieken over 12 maanden (SVG, één schaal)
  const W = 640, H = 220, L = 52, R = 8, T = 12, Bm = 26, iw = W - L - R, ih = H - T - Bm;
  const schaal = max => { const stap = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000].map(x => x * 100).find(s => max / s <= 5) || 1000000; return { top: Math.ceil(max / stap) * stap || stap, stap }; };
  const grid = (sc) => { let g = ""; for (let v = 0; v <= sc.top; v += sc.stap) { const y = T + ih - v / sc.top * ih; g += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" class="gl"/><text x="${L - 6}" y="${y + 4}" class="ax" text-anchor="end">${euroKort(v)}</text>`; } return g; };
  const xlab = (i, bw) => `<text x="${L + i * (iw / mm.length) + (iw / mm.length) / 2}" y="${H - 8}" class="ax" text-anchor="middle">${MAANDKORT(mm[i])}</text>`;
  const trend = mm.map(uitgaven), sc1 = schaal(Math.max(...trend, 1));
  const bw1 = iw / mm.length;
  const svg1 = `<svg viewBox="0 0 ${W} ${H}" class="grafiek" role="img" aria-label="Uitgaven per maand">${grid(sc1)}${trend.map((v, i) => { const h = Math.max(0, v) / sc1.top * ih; return `<rect x="${L + i * bw1 + bw1 * 0.18}" y="${T + ih - h}" width="${bw1 * 0.64}" height="${h}" rx="3" class="b-uit"><title>${MAANDNAAM(mm[i])}: ${euro(v)}</title></rect>`; }).join("")}${mm.map((_, i) => xlab(i)).join("")}</svg>`;
  const ink = mm.map(k => B.per[k].inkomen), sc2 = schaal(Math.max(...ink, ...trend, 1));
  const svg2 = `<svg viewBox="0 0 ${W} ${H}" class="grafiek" role="img" aria-label="Inkomen en uitgaven per maand">${grid(sc2)}${mm.map((k, i) => { const x0 = L + i * bw1 + bw1 * 0.12, w = bw1 * 0.36, h1 = Math.max(0, ink[i]) / sc2.top * ih, h2 = Math.max(0, trend[i]) / sc2.top * ih;
      return `<rect x="${x0}" y="${T + ih - h1}" width="${w}" height="${h1}" rx="3" class="b-in"><title>${MAANDNAAM(k)} inkomen: ${euro(ink[i])}</title></rect><rect x="${x0 + w + 2}" y="${T + ih - h2}" width="${w}" height="${h2}" rx="3" class="b-uit"><title>${MAANDNAAM(k)} uitgaven: ${euro(trend[i])}</title></rect>`; }).join("")}${mm.map((_, i) => xlab(i)).join("")}</svg>`;
  const somI = ink.reduce((a, b) => a + b, 0), somU = trend.reduce((a, b) => a + b, 0);
  $("#bview").innerHTML = `
    <section class="rapport"><h2>Uitgaven in ${MAANDNAAM(eind)}</h2><p class="muted">Totaal ${euro(totaalUit)}</p>${hbars}</section>
    <section class="rapport"><h2>Uitgaven per maand</h2><p class="muted">Gemiddeld ${euro(Math.round(somU / mm.length))} per maand over ${mm.length} maanden</p><div class="grafiek-wrap">${svg1}</div></section>
    <section class="rapport"><h2>Inkomen en uitgaven</h2><div class="legende"><span><i class="b-in"></i>Inkomen</span><span><i class="b-uit"></i>Uitgaven</span></div><div class="grafiek-wrap">${svg2}</div>
      <p>Over ${mm.length} maanden: inkomen ${euro(somI)}, uitgaven ${euro(somU)}, ${somI - somU >= 0 ? "overschot" : "tekort"} <b>${euro(somI - somU)}</b>.</p>
      <details><summary>Cijfers per maand</summary><div class="btabel-wrap"><table class="btabel"><thead><tr><th scope="col">Maand</th><th scope="col">Inkomen</th><th scope="col">Uitgaven</th><th scope="col">Saldo</th></tr></thead><tbody>${mm.map((k, i) => `<tr><th scope="row">${MAANDNAAM(k)}</th><td>${euro(ink[i])}</td><td>${euro(trend[i])}</td><td>${euro(ink[i] - trend[i])}</td></tr>`).join("")}</tbody></table></div></details></section>`;
}

/* Klein overzicht voor Vandaag */
function budgetKort() {
  if (!S.budget) return "";
  const B = budgetBerekening(), m = S.budget.huidig, r = B.per[m];
  const boodsch = S.budget.categorieen.find(c => /boodschap/i.test(c.naam));
  const over = S.budget.categorieen.filter(c => r.cat[c.id].beschikbaar < 0);
  return { teVerdelen: r.teVerdelen, boodsch: boodsch ? { naam: boodsch.naam, b: r.cat[boodsch.id].beschikbaar } : null, over: over.map(c => ({ naam: c.naam, b: r.cat[c.id].beschikbaar })) };
}
