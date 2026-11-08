/* Kring – agenda-scherm (R2). Gebruikt de globale hulpfuncties van index.html ($, esc, S, db, run, openPaneel …).
   Wordt vóór het hoofdscript geladen; functies worden pas aangeroepen na de start. */
"use strict";
const AG = window.KringAgenda;
const KLEUREN = ["#2f7a5b", "#3a6ea5", "#b03a48", "#8a4fa3", "#c48a1f", "#1f8a8a", "#b05a2a", "#5b6a64"];
const SYS = [   // ingebouwde kalenders (niet bewaard, enkel aan/uit)
  { id: "sys-taken", naam: "Taken", kleur: "#5b6a64" },
  { id: "sys-verj", naam: "Verjaardagen", kleur: "#c48a1f" },
  { id: "sys-maaltijd", naam: "Maaltijden", kleur: "#24493f" },
  { id: "sys-feest", naam: "Feestdagen BE", kleur: "#b05a2a" },
  { id: "sys-school", naam: "Schoolvakanties VL", kleur: "#8a4fa3" }
];
const HERH = [["", "Niet"], ["dag", "Elke dag"], ["week", "Elke week"], ["week2", "Om de 2 weken"], ["maand", "Elke maand"], ["jaar", "Elk jaar"]];
const HERINNER = [["", "Geen"], ["15", "15 min vooraf"], ["60", "1 uur vooraf"], ["1440", "1 dag vooraf"]];
const KORT = ["ma", "di", "wo", "do", "vr", "za", "zo"];
const MAANDEN = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

const zichtbaar = id => !S.verborgen.includes(id);
const kalender = id => S.kalenders.find(k => k.id === id) || SYS.find(k => k.id === id) || { naam: "?", kleur: "#5b6a64" };
const lid = id => S.leden.find(l => l.id === id);
const herhTekst = h => !h ? "" : h.freq === "week" && h.interval === 2 ? "om de 2 weken" : ({ dag: "elke dag", week: "elke week", maand: "elke maand", jaar: "elk jaar" })[h.freq] || "";

/* ---------- Items per dag ---------- */
function agendaItems(van, tot) {
  const per = {};
  const voeg = (d, it) => (per[d] = per[d] || []).push(it);
  for (const a of AG.rolUit(S.afspraken.filter(a => zichtbaar(a.kalender_id)), van, tot))
    voeg(a.dag, { soort: "afspraak", id: a.id, voorkomen: a.voorkomen, titel: a.titel, heleDag: a.hele_dag || (a.meerdaags && !a.eersteDag && !a.laatsteDag),
      tijd: a.hele_dag ? "" : (a.eersteDag ? a.start_tijd : (a.laatsteDag ? "tot " + (a.eind_tijd || "") : "")), eind: a.eersteDag && !a.meerdaags ? a.eind_tijd : "",
      kleur: kalender(a.kalender_id).kleur, plaats: a.plaats, wie: (a.deelnemers || []).map(lid).filter(Boolean), herh: !!a.herhaling, ics: a.ics });
  if (zichtbaar("sys-taken"))
    for (const t of AG.rolUit(S.taken.map(t => ({ ...t, datum: t.deadline })), van, tot))
      voeg(t.dag, { soort: "taak", id: t.id, voorkomen: t.voorkomen, titel: t.titel, tijd: t.tijd || "", heleDag: !t.tijd, kleur: (lid(t.lid_id) || {}).kleur || "#5b6a64",
        wie: [lid(t.lid_id)].filter(Boolean), klaar: (t.klaar || []).includes(t.voorkomen), herh: !!t.herhaling });
  if (zichtbaar("sys-taken"))
    for (const l of S.lijsten || []) for (const i of l.items) if (i.deadline && i.deadline >= van && i.deadline <= tot && (!l.prive || l.eigenaar === S.ik))
      voeg(i.deadline, { soort: "lijstitem", id: l.id + "|" + i.id, titel: i.tekst, tijd: "", heleDag: true, kleur: (lid(i.lid_id) || {}).kleur || "#5b6a64", wie: [lid(i.lid_id)].filter(Boolean), klaar: i.klaar, lijst: l.naam });
  if (zichtbaar("sys-verj"))
    for (const v of S.verjaardagen) {
      const n = AG.volgendeVerjaardag(v, van);
      if (n.datum <= tot) voeg(n.datum, { soort: "verjaardag", id: v.id, titel: n.leeftijd ? `${v.naam} wordt ${n.leeftijd}` : `Verjaardag ${v.naam}`, heleDag: true, kleur: kalender("sys-verj").kleur });
    }
  if (zichtbaar("sys-feest"))
    for (let j = +van.slice(0, 4); j <= +tot.slice(0, 4); j++)
      AG.feestdagen(j).filter(f => f.datum >= van && f.datum <= tot).forEach(f => voeg(f.datum, { soort: "feest", titel: f.naam, heleDag: true, kleur: kalender("sys-feest").kleur }));
  if (zichtbaar("sys-school"))
    AG.rolUit(AG.SCHOOLVAKANTIES.map((s, i) => ({ ...s, id: "sv" + i, titel: s.naam })), van, tot)
      .forEach(s => voeg(s.dag, { soort: "school", titel: s.titel, heleDag: true, kleur: kalender("sys-school").kleur }));
  if (zichtbaar("sys-maaltijd"))
    for (const m of S.menu) if (m.datum >= van && m.datum <= tot && m.moment === "avond") {
      const g = gerecht(m.gerecht_id); const t = g ? g.naam : m.vrije_tekst;
      if (t) voeg(m.datum, { soort: "maaltijd", titel: t, heleDag: true, kleur: kalender("sys-maaltijd").kleur });
    }
  const volg = { school: 0, feest: 1, verjaardag: 2, afspraak: 3, taak: 4, lijstitem: 5, maaltijd: 9 };
  for (const d in per) per[d].sort((a, b) => (a.heleDag === b.heleDag ? 0 : a.heleDag ? -1 : 1) || (a.tijd || "").localeCompare(b.tijd || "") || volg[a.soort] - volg[b.soort]);
  return per;
}

function itemRij(it, dagStr, kort) {
  const meta = [it.eind ? `tot ${it.eind}` : "", it.lijst ? "op " + it.lijst : "", it.plaats, it.wie && it.wie.length ? it.wie.map(w => w.naam).join(", ") : "", it.herh ? "↻" : ""].filter(Boolean).join(" · ");
  const klik = it.soort === "afspraak" || it.soort === "taak" || it.soort === "verjaardag" ? `data-item="${it.soort}|${it.id}|${it.voorkomen || dagStr}"` : it.soort === "lijstitem" ? `data-litembewerk="${it.id}"` : "";
  const cls = `ag-item ag-${it.soort}${it.klaar ? " klaar" : ""}${it.heleDag ? " heledag" : ""}`;
  const vink = it.soort === "taak" ? `<input type="checkbox" class="ag-vink" data-taak="${it.id}|${it.voorkomen}" ${it.klaar ? "checked" : ""} aria-label="Taak afvinken">`
    : it.soort === "lijstitem" ? `<input type="checkbox" class="ag-vink" data-litem="${it.id}" ${it.klaar ? "checked" : ""} aria-label="Afvinken">` : "";
  const label = it.soort === "maaltijd" ? `<span class="tag">avond</span> ` : it.soort === "school" || it.soort === "feest" ? "" : "";
  return `<div class="${cls}" style="--k:${it.kleur}">${vink}<button class="ag-knop" ${klik} ${klik ? "" : "disabled"}>
    ${it.tijd ? `<span class="ag-tijd">${esc(it.tijd)}</span>` : ""}<span class="ag-titel">${label}${esc(it.titel)}</span>${!kort && meta ? `<span class="ag-meta">${esc(meta)}</span>` : ""}</button></div>`;
}

/* ---------- Scherm ---------- */
function viewAgenda() {
  const vandaag = AG.iso(new Date());
  const chips = [...S.kalenders, ...SYS].map(k => `<button class="chip ag-chip" data-kal="${k.id}" aria-pressed="${zichtbaar(k.id)}" style="--k:${k.kleur}"><span class="dot"></span>${esc(k.naam)}</button>`).join("");
  const kop = `<div class="ag-kop">
      <div class="seg" role="group" aria-label="Weergave"><button data-agview="week" aria-pressed="${S.agendaView === "week"}">Week</button><button data-agview="maand" aria-pressed="${S.agendaView === "maand"}">Maand</button></div>
      <button class="knop" data-nieuwitem>+ Nieuw</button></div>
    <div class="chips ag-chips">${chips}</div>`;
  // Aandacht: taken te laat + verjaardagen binnen 14 dagen
  // Te laat: eenmalige taken van de voorbije 30 dagen; herhalende enkel het laatste gemiste voorkomen van de voorbije 7 dagen
  const telaat = S.taken.flatMap(t => {
    const vk = AG.voorkomens(t.deadline, 0, t.herhaling, AG.plus(vandaag, t.herhaling ? -7 : -30), AG.plus(vandaag, -1), t.uitzonderingen);
    const open = (t.herhaling ? vk.slice(-1) : vk).filter(d => !(t.klaar || []).includes(d));
    return open.map(d => ({ ...t, voorkomen: d }));
  });
  const verj = S.verjaardagen.map(v => ({ v, n: AG.volgendeVerjaardag(v, vandaag) })).filter(x => x.n.dagen <= 14).sort((a, b) => a.n.dagen - b.n.dagen);
  const aandacht = (telaat.length || verj.length) ? `<div class="ag-aandacht">
      ${telaat.map(t => `<div class="ag-item ag-taak telaat" style="--k:var(--danger)"><input type="checkbox" class="ag-vink" data-taak="${t.id}|${t.voorkomen}" aria-label="Taak afvinken"><button class="ag-knop" data-item="taak|${t.id}|${t.voorkomen}"><span class="ag-tijd">te laat</span><span class="ag-titel">${esc(t.titel)}</span><span class="ag-meta">${AG.dag(t.voorkomen).getDate()} ${MND[AG.dag(t.voorkomen).getMonth()]}${t.lid_id && lid(t.lid_id) ? " · " + esc(lid(t.lid_id).naam) : ""}</span></button></div>`).join("")}
      ${verj.map(({ v, n }) => `<div class="ag-item ag-verjaardag" style="--k:${kalender("sys-verj").kleur}"><button class="ag-knop" data-item="verjaardag|${v.id}|${n.datum}"><span class="ag-tijd">${n.dagen === 0 ? "vandaag" : n.dagen === 1 ? "morgen" : "over " + n.dagen + " d."}</span><span class="ag-titel">${esc(n.leeftijd ? `${v.naam} wordt ${n.leeftijd}` : `Verjaardag ${v.naam}`)}</span></button></div>`).join("")}
    </div>` : "";
  let body;
  if (S.agendaView === "maand") {
    const m0 = new Date(S.maand.getFullYear(), S.maand.getMonth(), 1, 12);
    const start = AG.plus(AG.iso(m0), 1 - AG.weekdag(AG.iso(m0)));
    const last = new Date(m0.getFullYear(), m0.getMonth() + 1, 0, 12);
    const eind = AG.plus(AG.iso(last), 7 - AG.weekdag(AG.iso(last)));
    const per = agendaItems(start, eind);
    const cellen = [];
    for (let d = start; d <= eind; d = AG.plus(d, 1)) {
      const it = per[d] || [], buiten = AG.dag(d).getMonth() !== m0.getMonth();
      cellen.push(`<button class="mcel${buiten ? " buiten" : ""}${d === vandaag ? " vandaag" : ""}" data-dag="${d}" aria-label="${AG.dag(d).getDate()} ${MAANDEN[AG.dag(d).getMonth()]}, ${it.length} items">
        <span class="mnr">${AG.dag(d).getDate()}</span>
        <span class="mitems">${it.filter(x => x.soort !== "maaltijd").slice(0, 3).map(x => `<span class="mi${x.heleDag ? " hd" : ""}" style="--k:${x.kleur}">${x.tijd ? esc(x.tijd) + " " : ""}${esc(x.titel)}</span>`).join("")}${it.length > 3 ? `<span class="mmeer">+${it.length - 3}</span>` : ""}</span>
        <span class="mdots">${it.slice(0, 5).map(x => `<i style="--k:${x.kleur}"></i>`).join("")}</span></button>`);
    }
    body = `<div class="maand"><div class="mkop">${KORT.map(k => `<span>${k}</span>`).join("")}</div><div class="mgrid">${cellen.join("")}</div></div>`;
  } else {
    const van = AG.iso(S.week), tot = AG.plus(van, 6), per = agendaItems(van, tot);
    body = `<div class="dagen">${[0, 1, 2, 3, 4, 5, 6].map(i => {
      const d = AG.plus(van, i), it = per[d] || [];
      return `<section class="dag ag-dag ${d === vandaag ? "is-vandaag" : ""}">
        <div class="dagkop"><span class="dagnaam">${DAGEN[i]}</span><span class="datum">${AG.dag(d).getDate()} ${MND[AG.dag(d).getMonth()]}</span><button class="ag-plus" data-nieuwop="${d}" aria-label="Nieuw op ${DAGEN[i]}">+</button></div>
        <div class="ag-lijst">${it.length ? it.map(x => itemRij(x, d)).join("") : `<button class="ag-leeg" data-nieuwop="${d}">Niets gepland</button>`}</div></section>`;
    }).join("")}</div>`;
  }
  $("#view").innerHTML = agendaBanner() + kop + aandacht + body;
}
function agendaBanner() {
  return db.demo ? `<div class="banner"><b>Testversie agenda</b> met voorbeeldafspraken en -taken (geen echte gegevens), echte Belgische feestdagen en Vlaamse schoolvakanties. Herinneringen en Google Agenda werken pas in de echte versie.</div>` : "";
}

/* Afspraken van een dag voor het weekmenu (agenda naast het weekmenu) */
function dagAgendaKort(ds) {
  const it = (agendaItems(ds, ds)[ds] || []).filter(x => x.soort !== "maaltijd" && x.soort !== "school");
  if (!it.length) return "";
  return `<div class="ag-kort">${it.slice(0, 4).map(x => `<span style="--k:${x.kleur}" class="${x.soort === "taak" && x.klaar ? "klaar" : ""}">${x.tijd ? `<b>${esc(x.tijd)}</b> ` : ""}${esc(x.titel)}</span>`).join("")}${it.length > 4 ? `<span>+${it.length - 4}</span>` : ""}</div>`;
}

/* ---------- Panelen ---------- */
function openDag(ds) {
  const it = agendaItems(ds, ds)[ds] || [];
  const d = AG.dag(ds);
  openPaneel(`<div class="paneel-kop"><h2>${DAGEN[(d.getDay() + 6) % 7]} ${d.getDate()} ${MAANDEN[d.getMonth()]}</h2><button class="ib" data-sluit aria-label="Sluiten">✕</button></div>
    <div class="ag-lijst">${it.length ? it.map(x => itemRij(x, ds)).join("") : `<p class="muted">Niets gepland.</p>`}</div>
    <div class="voet"><button class="knop sec" data-nieuw-soort="verjaardag|${ds}">+ Verjaardag</button><button class="knop sec" data-nieuw-soort="taak|${ds}">+ Taak</button><button class="knop" data-nieuw-soort="afspraak|${ds}">+ Afspraak</button></div>`);
  $("#paneel").onclick = agendaPaneelKlik;
  $("#paneel").onchange = agendaVinkWijzig;
}
function openNieuwKeuze(ds) {
  openPaneel(`<div class="paneel-kop"><h2>Nieuw</h2><button class="ib" data-sluit aria-label="Sluiten">✕</button></div>
    <div class="keuzes"><button class="keuze" data-nieuw-soort="afspraak|${ds}"><span>Afspraak<small>met tijd of hele dag, eventueel herhalend</small></span></button>
    <button class="keuze" data-nieuw-soort="taak|${ds}"><span>Taak met deadline<small>bv. afval buitenzetten, formulier terugbezorgen</small></span></button>
    <button class="keuze" data-nieuw-soort="verjaardag|${ds}"><span>Verjaardag<small>komt elk jaar terug</small></span></button></div>`);
  $("#paneel").onclick = agendaPaneelKlik;
}
function agendaPaneelKlik(e) {
  const t = e.target.closest("button"); if (!t) return;
  if (t.dataset.nieuwSoort) { const [s, d] = t.dataset.nieuwSoort.split("|"); ({ afspraak: openAfspraak, taak: openTaak, verjaardag: openVerjaardag })[s](null, d); }
  else if (t.dataset.item) openItem(t.dataset.item);
}
function agendaVinkWijzig(e) {
  const v = e.target.dataset && e.target.dataset.taak; if (!v) return;
  const [id, d] = v.split("|"), val = e.target.checked;
  e.target.closest(".ag-item").classList.toggle("klaar", val);
  run(async () => { await db.vinkTaak(id, d, val); const t = S.taken.find(x => x.id === id); if (val && t) await db.log(`vinkte '${t.titel}' af`); await Promise.all([herlaadAgenda(), herlaadGezin()]); if ($("#sheet").hidden) render(); });
}
function openItem(v) {
  const [soort, id, d] = v.split("|");
  if (soort === "afspraak") openAfspraak(id, d); else if (soort === "taak") openTaak(id, d); else if (soort === "verjaardag") openVerjaardag(id);
}

const lidChips = (sel, naam = "wie") => `<div class="chips" style="margin:0">${S.leden.map(l => `<label class="chip toggle" style="--k:${l.kleur}"><input type="checkbox" name="${naam}" value="${l.id}" ${sel.includes(l.id) ? "checked" : ""}> ${esc(l.naam)}</label>`).join("")}</div>`;
const herhVeld = (h, ds) => {
  const v = !h ? "" : h.freq === "week" && h.interval === 2 ? "week2" : h.freq;
  const dagen = h && h.dagen && h.dagen.length ? h.dagen : [AG.weekdag(ds)];
  return `<div class="rij"><div class="veld"><label for="a-herh">Herhalen</label><select class="in" id="a-herh">${HERH.map(([k, l]) => `<option value="${k}" ${k === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    <div class="veld"><label for="a-tot">Tot en met</label><input class="in" id="a-tot" type="date" value="${h && h.tot ? h.tot : ""}"></div></div>
    <div id="a-dagen" class="chips" ${v === "week" || v === "week2" ? "" : "hidden"}>${KORT.map((k, i) => `<label class="chip toggle"><input type="checkbox" name="wd" value="${i + 1}" ${dagen.includes(i + 1) ? "checked" : ""}> ${k}</label>`).join("")}</div>`;
};
function leesHerh(p) {
  const v = p.querySelector("#a-herh").value; if (!v) return null;
  const dagen = [...p.querySelectorAll('input[name="wd"]:checked')].map(x => +x.value);
  return { freq: v === "week2" ? "week" : v, interval: v === "week2" ? 2 : 1, dagen: v.startsWith("week") ? dagen : [], tot: p.querySelector("#a-tot").value || null };
}
function verwijderKnoppen(item, d) {
  return item ? (item.herhaling ? `<button type="button" class="knop gevaar links" data-wis-een="${d}">Enkel ${AG.dag(d).getDate()}/${AG.dag(d).getMonth() + 1} schrappen</button><button type="button" class="knop gevaar" data-wis-alles>Hele reeks</button>`
    : `<button type="button" class="knop gevaar links" data-wis-alles>Verwijderen</button>`) : "";
}

function openAfspraak(id, ds) {
  const a = id ? JSON.parse(JSON.stringify(S.afspraken.find(x => x.id === id))) : { titel: "", kalender_id: (S.kalenders[0] || {}).id, hele_dag: false, datum: ds || AG.iso(new Date()), datum_tot: null, start_tijd: "19:00", eind_tijd: "20:00", plaats: "", notitie: "", deelnemers: [], herhaling: null, herinnering_min: null, uitzonderingen: [] };
  const ro = !!a.ics;
  openPaneel(`<form id="a-form" novalidate>
    <div class="paneel-kop"><h2>${id ? (ro ? "Afspraak (geïmporteerd)" : "Afspraak bewerken") : "Nieuwe afspraak"}</h2><button type="button" class="ib" data-sluit aria-label="Sluiten">✕</button></div>
    ${ro ? `<p class="banner">Deze afspraak komt uit een geïmporteerde agenda en kan je hier niet wijzigen.</p>` : ""}
    <fieldset ${ro ? "disabled" : ""} style="border:0;padding:0;margin:0" class="stack">
    <div class="veld"><label for="a-titel">Titel</label><input class="in" id="a-titel" value="${esc(a.titel)}" ${id ? "" : "autofocus"} required></div>
    <div class="rij"><div class="veld"><label for="a-kal">Agenda</label><select class="in" id="a-kal">${S.kalenders.filter(k => k.soort !== "ics" || k.id === a.kalender_id).map(k => `<option value="${k.id}" ${k.id === a.kalender_id ? "selected" : ""}>${esc(k.naam)}</option>`).join("")}</select></div>
      <label class="toggle" style="align-self:end;padding-bottom:10px"><input type="checkbox" id="a-hd" ${a.hele_dag ? "checked" : ""}> Hele dag</label></div>
    <div class="rij"><div class="veld"><label for="a-datum">Van</label><input class="in" id="a-datum" type="date" value="${a.datum}"></div>
      <div class="veld"><label for="a-datumtot">Tot (meerdere dagen)</label><input class="in" id="a-datumtot" type="date" value="${a.datum_tot || ""}"></div></div>
    <div class="rij" id="a-tijden" ${a.hele_dag ? "hidden" : ""}><div class="veld"><label for="a-start">Begin</label><input class="in" id="a-start" type="time" value="${a.start_tijd || ""}"></div>
      <div class="veld"><label for="a-eind">Einde</label><input class="in" id="a-eind" type="time" value="${a.eind_tijd || ""}"></div></div>
    ${herhVeld(a.herhaling, a.datum)}
    <div class="veld"><label>Wie</label>${lidChips(a.deelnemers || [])}</div>
    <div class="rij"><div class="veld"><label for="a-plaats">Plaats</label><input class="in" id="a-plaats" value="${esc(a.plaats)}"></div>
      <div class="veld"><label for="a-her">Herinnering</label><select class="in" id="a-her">${HERINNER.map(([k, l]) => `<option value="${k}" ${String(a.herinnering_min ?? "") === k ? "selected" : ""}>${l}</option>`).join("")}</select></div></div>
    <div class="veld"><label for="a-notitie">Notitie</label><textarea class="in" id="a-notitie" style="min-height:60px">${esc(a.notitie)}</textarea></div>
    </fieldset>
    <div class="voet">${ro ? "" : verwijderKnoppen(id && a, ds || a.datum)}<button type="button" class="knop sec" data-sluit>${ro ? "Sluiten" : "Annuleren"}</button>${ro ? "" : `<button class="knop" type="submit">Bewaren</button>`}</div></form>`);
  const p = $("#paneel"); let zeker = false;
  p.onchange = e => {
    if (e.target.id === "a-hd") p.querySelector("#a-tijden").hidden = e.target.checked;
    if (e.target.id === "a-herh") p.querySelector("#a-dagen").hidden = !e.target.value.startsWith("week");
  };
  p.onclick = e => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.wisEen) run(async () => { await db.schrapVoorkomen(id, t.dataset.wisEen); await herlaadAgenda(); sluitPaneel(); render(); toast("Geschrapt voor die dag"); });
    else if ("wisAlles" in t.dataset) { if (!zeker) { zeker = true; t.textContent = "Zeker? Tik nogmaals"; t.classList.add("zeker"); return; }
      run(async () => { await db.verwijderAfspraak(id); await herlaadAgenda(); sluitPaneel(); render(); toast("Verwijderd"); }); }
  };
  p.onsubmit = e => {
    e.preventDefault();
    const titel = p.querySelector("#a-titel").value.trim(); if (!titel) return toast("Geef een titel");
    const hd = p.querySelector("#a-hd").checked, datum = p.querySelector("#a-datum").value; if (!datum) return toast("Kies een datum");
    let tot = p.querySelector("#a-datumtot").value || null; if (tot && tot <= datum) tot = null;
    const n = { ...a, titel, kalender_id: p.querySelector("#a-kal").value, hele_dag: hd, datum, datum_tot: tot,
      start_tijd: hd ? null : p.querySelector("#a-start").value || null, eind_tijd: hd ? null : p.querySelector("#a-eind").value || null,
      herhaling: leesHerh(p), deelnemers: [...p.querySelectorAll('input[name="wie"]:checked')].map(x => x.value),
      plaats: p.querySelector("#a-plaats").value.trim(), herinnering_min: p.querySelector("#a-her").value ? +p.querySelector("#a-her").value : null,
      notitie: p.querySelector("#a-notitie").value.trim() };
    run(async () => { await db.bewaarAfspraak(n); await herlaadAgenda(); sluitPaneel(); render(); toast("Bewaard"); });
  };
}

function openTaak(id, ds) {
  const t0 = id ? JSON.parse(JSON.stringify(S.taken.find(x => x.id === id))) : { titel: "", deadline: ds || AG.iso(new Date()), tijd: "", lid_id: null, herhaling: null, notitie: "", klaar: [] };
  openPaneel(`<form id="t-form" novalidate>
    <div class="paneel-kop"><h2>${id ? "Taak bewerken" : "Nieuwe taak"}</h2><button type="button" class="ib" data-sluit aria-label="Sluiten">✕</button></div>
    <div class="stack">
    <div class="veld"><label for="t-titel">Taak</label><input class="in" id="t-titel" value="${esc(t0.titel)}" ${id ? "" : "autofocus"}></div>
    <div class="rij"><div class="veld"><label for="a-datum">Deadline</label><input class="in" id="a-datum" type="date" value="${t0.deadline}"></div>
      <div class="veld"><label for="t-tijd">Tijd (optioneel)</label><input class="in" id="t-tijd" type="time" value="${t0.tijd || ""}"></div></div>
    ${herhVeld(t0.herhaling, t0.deadline)}
    <div class="veld"><label for="t-wie">Wie doet het</label><select class="in" id="t-wie"><option value="">Iemand</option>${S.leden.map(l => `<option value="${l.id}" ${l.id === t0.lid_id ? "selected" : ""}>${esc(l.naam)}</option>`).join("")}</select></div>
    <div class="veld"><label for="t-notitie">Notitie</label><textarea class="in" id="t-notitie" style="min-height:60px">${esc(t0.notitie)}</textarea></div>
    </div>
    <div class="voet">${verwijderKnoppen(id && t0, ds || t0.deadline)}<button type="button" class="knop sec" data-sluit>Annuleren</button><button class="knop" type="submit">Bewaren</button></div></form>`);
  const p = $("#paneel"); let zeker = false;
  p.onchange = e => { if (e.target.id === "a-herh") p.querySelector("#a-dagen").hidden = !e.target.value.startsWith("week"); };
  p.onclick = e => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.wisEen) run(async () => { await db.schrapTaakVoorkomen(id, t.dataset.wisEen); await herlaadAgenda(); sluitPaneel(); render(); });
    else if ("wisAlles" in t.dataset) { if (!zeker) { zeker = true; t.textContent = "Zeker? Tik nogmaals"; t.classList.add("zeker"); return; }
      run(async () => { await db.verwijderTaak(id); await herlaadAgenda(); sluitPaneel(); render(); toast("Verwijderd"); }); }
  };
  p.onsubmit = e => {
    e.preventDefault();
    const titel = p.querySelector("#t-titel").value.trim(); if (!titel) return toast("Geef de taak een naam");
    const n = { ...t0, titel, deadline: p.querySelector("#a-datum").value, tijd: p.querySelector("#t-tijd").value || null, herhaling: leesHerh(p),
      lid_id: p.querySelector("#t-wie").value || null, notitie: p.querySelector("#t-notitie").value.trim() };
    run(async () => { await db.bewaarTaak(n); await herlaadAgenda(); sluitPaneel(); render(); toast("Bewaard"); });
  };
}

function openVerjaardag(id, ds) {
  const v = id ? { ...S.verjaardagen.find(x => x.id === id) } : { naam: "", datum: ds || AG.iso(new Date()), geboortejaar: null, notitie: "" };
  const datumIn = v.geboortejaar ? `${v.geboortejaar}${v.datum.slice(4)}` : v.datum;
  openPaneel(`<form id="v-form" novalidate>
    <div class="paneel-kop"><h2>${id ? "Verjaardag" : "Nieuwe verjaardag"}</h2><button type="button" class="ib" data-sluit aria-label="Sluiten">✕</button></div>
    <div class="stack">
    <div class="veld"><label for="v-naam">Naam</label><input class="in" id="v-naam" value="${esc(v.naam)}" ${id ? "" : "autofocus"}></div>
    <div class="rij"><div class="veld"><label for="v-datum">Geboortedatum</label><input class="in" id="v-datum" type="date" value="${datumIn}"></div>
      <label class="toggle" style="align-self:end;padding-bottom:10px"><input type="checkbox" id="v-jaar" ${v.geboortejaar || !id ? "checked" : ""}> Jaar klopt (leeftijd tonen)</label></div>
    <div class="veld"><label for="v-notitie">Notitie (bv. cadeau-idee)</label><textarea class="in" id="v-notitie" style="min-height:60px">${esc(v.notitie)}</textarea></div>
    </div>
    <div class="voet">${id ? `<button type="button" class="knop gevaar links" data-wis-alles>Verwijderen</button>` : ""}<button type="button" class="knop sec" data-sluit>Annuleren</button><button class="knop" type="submit">Bewaren</button></div></form>`);
  const p = $("#paneel"); let zeker = false;
  p.onclick = e => { const t = e.target.closest("button"); if (t && "wisAlles" in t.dataset) { if (!zeker) { zeker = true; t.textContent = "Zeker? Tik nogmaals"; t.classList.add("zeker"); return; }
    run(async () => { await db.verwijderVerjaardag(id); await herlaadAgenda(); sluitPaneel(); render(); }); } };
  p.onsubmit = e => {
    e.preventDefault();
    const naam = p.querySelector("#v-naam").value.trim(), d = p.querySelector("#v-datum").value; if (!naam || !d) return toast("Naam en datum zijn nodig");
    const metJaar = p.querySelector("#v-jaar").checked;
    run(async () => { await db.bewaarVerjaardag({ ...v, naam, datum: d, geboortejaar: metJaar ? +d.slice(0, 4) : null, notitie: p.querySelector("#v-notitie").value.trim() }); await herlaadAgenda(); sluitPaneel(); render(); toast("Bewaard"); });
  };
}

/* ---------- Instellingen: leden, agenda's, ICS ---------- */
function instellingenAgendaHtml() {
  const kl = (sel, naam) => `<select class="in" name="${naam}" aria-label="Kleur">${KLEUREN.map(k => `<option value="${k}" ${k === sel ? "selected" : ""} style="color:${k}">● ${k}</option>`).join("")}</select>`;
  return `${db.demo ? `<div class="veld"><label for="ik-sel">Ik ben (testversie)</label><select class="in" id="ik-sel">${S.leden.map(l => `<option value="${l.id}" ${l.id === S.ik ? "selected" : ""}>${esc(l.naam)}</option>`).join("")}</select></div>` : ""}
    <div class="lbl-klein" style="margin-top:8px">Gezinsleden</div>
    <div class="stack">${S.leden.map(l => `<div class="instrij" style="--k:${l.kleur}"><span class="dot"></span><span>${esc(l.naam)}</span>${l.heeft_account ? `<span class="tag">account</span>` : ""}</div>`).join("")}
      <form class="instform" id="f-lid"><input class="in" id="lid-naam" placeholder="Naam (bv. kind zonder account)" aria-label="Naam gezinslid">${kl(KLEUREN[3], "lid-kleur")}<button class="knop sec klein">Toevoegen</button></form></div>
    <div class="lbl-klein" style="margin-top:8px">Agenda's</div>
    <div class="stack">${S.kalenders.map(k => `<div class="instrij" style="--k:${k.kleur}"><span class="dot"></span><span>${esc(k.naam)}</span>${k.soort === "ics" ? `<span class="tag">geïmporteerd</span><button class="link" data-wiskal="${k.id}" style="margin-left:auto">verwijderen</button>` : ""}</div>`).join("")}
      <form class="instform" id="f-kal"><input class="in" id="kal-naam" placeholder="Nieuwe agenda (bv. Werk)" aria-label="Naam agenda">${kl(KLEUREN[5], "kal-kleur")}<button class="knop sec klein">Toevoegen</button></form></div>
    <div class="lbl-klein" style="margin-top:8px">Externe agenda (school, sportclub)</div>
    <div class="stack"><label class="knop sec" style="text-align:center;cursor:pointer">ICS-bestand importeren<input type="file" id="ics-file" accept=".ics,text/calendar" hidden></label>
      <form class="instform" id="f-ics"><input class="in" id="ics-url" type="url" placeholder="https://… .ics (abonneren)" aria-label="ICS-link"><button class="knop sec klein">Abonneren</button></form>
      <p class="muted" style="font-size:.85rem;margin:0">Abonneren houdt de agenda automatisch bij. Dat werkt pas in de echte versie; in de testversie kan je een .ics-bestand importeren.</p></div>`;
}
function instellingenAgendaBind(p) {
  if (p.dataset.agBound) return; p.dataset.agBound = "1";
  p.addEventListener("submit", e => {
    e.preventDefault();
    if (e.target.id === "f-lid") { const n = p.querySelector("#lid-naam").value.trim(); if (!n) return;
      run(async () => { await db.bewaarLid({ naam: n, kleur: p.querySelector('[name="lid-kleur"]').value }); await herlaadAgenda(); openInstellingen(); toast("Gezinslid toegevoegd"); }); }
    if (e.target.id === "f-kal") { const n = p.querySelector("#kal-naam").value.trim(); if (!n) return;
      run(async () => { await db.bewaarKalender({ naam: n, kleur: p.querySelector('[name="kal-kleur"]').value, soort: "eigen" }); await herlaadAgenda(); openInstellingen(); toast("Agenda toegevoegd"); }); }
    if (e.target.id === "f-ics") { const u = p.querySelector("#ics-url").value.trim(); if (!u) return;
      run(async () => { const n = await db.abonneerICS(u); await herlaadAgenda(); sluitPaneel(); render(); toast(`${n} afspraken geladen`); }); }
  });
  p.addEventListener("change", e => {
    if (e.target.id === "ik-sel") { S.ik = e.target.value; pref.set("ik", S.ik); render(); return; }
    if (e.target.id !== "ics-file" || !e.target.files[0]) return;
    const f = e.target.files[0], r = new FileReader();
    r.onload = () => run(async () => {
      const ev = AG.leesICS(String(r.result));
      if (!ev.length) throw new Error("geen afspraken gevonden in dit bestand");
      const n = await db.importeerICS(f.name.replace(/\.ics$/i, ""), KLEUREN[(S.kalenders.length + 2) % KLEUREN.length], ev);
      await herlaadAgenda(); sluitPaneel(); S.tab = "agenda"; render();
      const onv = ev.filter(x => x.onvolledig).length;
      toast(`${n} afspraken geïmporteerd${onv ? ` (${onv} met een herhaling die als eenmalig is ingelezen)` : ""}`);
    });
    r.readAsText(f);
  });
  p.addEventListener("click", e => { const t = e.target.closest("[data-wiskal]"); if (t) run(async () => { await db.verwijderKalender(t.dataset.wiskal); await herlaadAgenda(); openInstellingen(); }); });
}

/* ---------- Testdata agenda ---------- */
function demoAgenda() {
  const w = AG.iso(maandag(new Date())), d = n => AG.plus(w, n);
  const [n1, n2] = (window.KRING_SEED && window.KRING_SEED.namen) || ["Ouder 1", "Ouder 2"];   // namen enkel in de lokale testversie
  const leden = [{ id: uid(), naam: n1, kleur: "#3a6ea5", heeft_account: true }, { id: uid(), naam: n2, kleur: "#b03a48", heeft_account: true }];
  const [C, Sa] = leden.map(l => l.id);
  const kalenders = [{ id: uid(), naam: "Gezin", kleur: "#2f7a5b", soort: "eigen" }, { id: uid(), naam: n1, kleur: "#3a6ea5", soort: "eigen" }, { id: uid(), naam: n2, kleur: "#b03a48", soort: "eigen" }];
  const [G, KC, KS] = kalenders.map(k => k.id);
  const A = (o) => ({ id: uid(), hele_dag: false, datum_tot: null, plaats: "", notitie: "", deelnemers: [], herhaling: null, uitzonderingen: [], herinnering_min: null, ...o });
  const afspraken = [
    A({ titel: "Zwemles", kalender_id: G, datum: AG.plus(w, -63 + 2), start_tijd: "14:00", eind_tijd: "15:00", plaats: "Zwembad", herhaling: { freq: "week", interval: 1, dagen: [3], tot: "2027-06-30" } }),
    A({ titel: "Voetbaltraining", kalender_id: G, datum: AG.plus(w, -62), start_tijd: "18:00", eind_tijd: "19:30", herhaling: { freq: "week", interval: 1, dagen: [2, 4], tot: null } }),
    A({ titel: "Kapper", kalender_id: KS, datum: d(3), start_tijd: "19:00", eind_tijd: "19:45", deelnemers: [Sa] }),
    A({ titel: "Etentje met vrienden", kalender_id: G, datum: d(5), start_tijd: "19:30", eind_tijd: "23:00", deelnemers: [C, Sa], herinnering_min: 60 }),
    A({ titel: "Oudercontact", kalender_id: G, datum: d(8), start_tijd: "17:30", eind_tijd: "18:00", plaats: "School", deelnemers: [C, Sa] }),
    A({ titel: "Raad van bestuur", kalender_id: KC, datum: d(9), start_tijd: "19:00", eind_tijd: "21:00", deelnemers: [C] }),
    A({ titel: "Weekendje Ardennen", kalender_id: G, datum: d(11), datum_tot: d(13), hele_dag: true, start_tijd: null, eind_tijd: null })
  ];
  const T = o => ({ id: uid(), tijd: null, lid_id: null, herhaling: null, notitie: "", klaar: [], ...o });
  const taken = [
    T({ titel: "Restafval buitenzetten", deadline: AG.plus(w, -70), tijd: "20:00", lid_id: C, herhaling: { freq: "week", interval: 1, dagen: [1], tot: null }, klaar: [w] }),
    T({ titel: "PMD buitenzetten", deadline: AG.plus(w, -69), tijd: "20:00", lid_id: Sa, herhaling: { freq: "week", interval: 2, dagen: [2], tot: null } }),
    T({ titel: "Oven kuisen", deadline: d(6), lid_id: C, herhaling: { freq: "maand", interval: 1, dagen: [], tot: null } }),
    T({ titel: "Formulier school terugbezorgen", deadline: AG.plus(AG.iso(new Date()), -1), lid_id: Sa })
  ];
  const verjaardagen = [
    { id: uid(), naam: "Oma (voorbeeld)", datum: `1950-${AG.plus(AG.iso(new Date()), 6).slice(5)}`, geboortejaar: 1950, notitie: "" },
    { id: uid(), naam: "Meter (voorbeeld)", datum: `1978-${AG.plus(AG.iso(new Date()), 40).slice(5)}`, geboortejaar: null, notitie: "" }
  ];
  return { leden, kalenders, afspraken, taken, verjaardagen };
}
