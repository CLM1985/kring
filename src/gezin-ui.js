/* Kring – R3 Gezin: Vandaag-overzicht, lijsten (to-do en vrije lijsten), activiteit en snel toevoegen. */
"use strict";
const LIJSTSOORT = [["todo", "To-do"], ["lijst", "Lijst"], ["boodschap", "Boodschappen"]];
const ik = () => S.leden.find(l => l.id === S.ik) || S.leden[0] || { naam: "Ik" };

function tijdGeleden(ts) {
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return "net nu"; if (s < 3600) return `${Math.floor(s / 60)} min geleden`; if (s < 86400) return `${Math.floor(s / 3600)} u geleden`;
  const d = Math.floor(s / 86400); return d === 1 ? "gisteren" : `${d} dagen geleden`;
}

/* ---------- Vandaag ---------- */
function viewVandaag() {
  const nu = new Date(), vd = AG.iso(nu);
  const items = (agendaItems(vd, vd)[vd] || []).filter(x => x.soort !== "maaltijd");
  const telaat = S.taken.flatMap(t => {
    const vk = AG.voorkomens(t.deadline, 0, t.herhaling, AG.plus(vd, t.herhaling ? -7 : -30), AG.plus(vd, -1), t.uitzonderingen);
    return (t.herhaling ? vk.slice(-1) : vk).filter(d => !(t.klaar || []).includes(d)).map(d => ({ soort: "taak", id: t.id, voorkomen: d, titel: t.titel, tijd: "te laat", kleur: "var(--danger)", wie: [lid(t.lid_id)].filter(Boolean) }));
  });
  const avond = S.menu.find(m => m.datum === vd && m.moment === "avond"), g = avond && gerecht(avond.gerecht_id);
  const lijst = lijstItems().filter(i => !i.voorraad), open = lijst.filter(i => !i.af);
  const kost = open.reduce((s, i) => s + ((i.product && i.pak && i.pak.kost) || 0), 0);
  const verj = S.verjaardagen.map(v => ({ v, n: AG.volgendeVerjaardag(v, vd) })).filter(x => x.n.dagen <= 14).sort((a, b) => a.n.dagen - b.n.dagen);
  const mijnTodo = S.lijsten.flatMap(l => l.items.filter(i => !i.klaar && (i.lid_id === ik().id || (!i.lid_id && l.soort === "todo"))).map(i => ({ ...i, lijst: l })));
  const bk = budgetKort();
  const kaart = (titel, inhoud, actie) => `<section class="vk"><div class="vk-kop"><h2>${titel}</h2>${actie || ""}</div>${inhoud}</section>`;
  $("#view").innerHTML = `
    <h1 class="groet">${["Goedenacht", "Goeiemorgen", "Goeiemiddag", "Goeieavond"][Math.floor(nu.getHours() / 6)]}, ${esc(ik().naam)}</h1>
    <p class="muted" style="margin:-4px 0 14px">${DAGEN[(nu.getDay() + 6) % 7]} ${nu.getDate()} ${MAANDEN[nu.getMonth()]}</p>
    <div class="vgrid">
    ${kaart("Vandaag", `<div class="ag-lijst">${[...telaat, ...items].map(x => itemRij(x, vd)).join("") || `<p class="muted">Niets gepland vandaag.</p>`}</div>`, `<button class="link" data-goto="agenda">Agenda</button>`)}
    ${kaart("Vanavond", g ? `<button class="vk-groot" data-open="${g.id}">${esc(g.naam)}</button><p class="muted">${avond.porties || g.porties} personen${zonderIngr(g) ? "" : ` · ${g.ingredienten.length} ingrediënten`}</p>`
        : avond && avond.vrije_tekst ? `<p class="vk-groot">${esc(avond.vrije_tekst)}</p>` : `<button class="ag-leeg" data-slot="${vd}|avond">Nog niets gepland. Kies een gerecht</button>`, `<button class="link" data-goto="menu">Weekmenu</button>`)}
    ${kaart("Boodschappen", `<p><span class="getal">${open.length}</span> <span class="muted">van ${lijst.length} nog te kopen${kost ? ` · geraamd ${eur(kost / 1)}` : ""}</span></p>`, `<button class="link" data-goto="lijst">Lijst</button>`)}
    ${bk ? kaart("Budget", `<p><span class="getal ${bk.teVerdelen < 0 ? "neg" : ""}">${euro(bk.teVerdelen)}</span> <span class="muted">te verdelen</span></p>
        ${bk.boodsch ? `<p>${esc(bk.boodsch.naam)}: nog <b>${euro(bk.boodsch.b)}</b> deze maand</p>` : ""}
        ${bk.over.length ? `<p class="neg-tekst">Overbesteed: ${bk.over.map(o => `${esc(o.naam)} ${euro(o.b)}`).join(", ")}</p>` : ""}`, `<button class="link" data-goto="budget">Budget</button>`) : ""}
    ${mijnTodo.length ? kaart("Voor jou", `<ul class="vlijst">${mijnTodo.slice(0, 6).map(i => `<li><label><input type="checkbox" data-litem="${i.lijst.id}|${i.id}"> ${esc(i.tekst)}</label><span class="muted">${esc(i.lijst.naam)}</span></li>`).join("")}</ul>`, `<button class="link" data-goto="lijsten">Lijsten</button>`) : ""}
    ${verj.length ? kaart("Verjaardagen", `<ul class="vlijst">${verj.map(({ v, n }) => `<li><span>${esc(n.leeftijd ? `${v.naam} wordt ${n.leeftijd}` : v.naam)}</span><span class="muted">${n.dagen === 0 ? "vandaag" : n.dagen === 1 ? "morgen" : "over " + n.dagen + " dagen"}</span></li>`).join("")}</ul>`) : ""}
    ${kaart("Recent", `<ul class="vlijst act">${S.activiteit.slice(0, 8).map(a => `<li><span><b>${esc(a.wie)}</b> ${esc(a.wat)}</span><span class="muted">${tijdGeleden(a.op)}</span></li>`).join("") || `<li class="muted">Nog geen activiteit.</li>`}</ul>`)}
    </div>`;
}

/* ---------- Lijsten ---------- */
function viewLijsten() {
  const l = S.lijsten.find(x => x.id === S.lijstOpen);
  if (l) return viewLijst1(l);
  const vast = S.lijsten.filter(x => x.vast), ander = S.lijsten.filter(x => !x.vast && (!x.prive || x.eigenaar === ik().id));
  const rij = x => { const open = x.items.filter(i => !i.klaar).length; return `<button class="lrij" data-lijst="${x.id}"><span class="licoon ${x.soort}" aria-hidden="true"></span><span class="lnaam">${esc(x.naam)}<small>${x.prive ? "Privé" : "Gedeeld met iedereen"}${x.soort === "todo" ? " · to-do" : ""}</small></span><span class="lteller">${open}</span></button>`; };
  const bood = lijstItems().filter(i => !i.voorraad && !i.af).length;
  $("#view").innerHTML = (db.demo ? `<div class="banner"><b>Testversie lijsten</b> met voorbeeldlijsten. De boodschappenlijst van het weekmenu staat bovenaan.</div>` : "") + `
    <div class="ag-kop"><h1 style="font-size:1.4rem">Lijsten</h1><button class="knop" data-nieuwelijst>+ Nieuwe lijst</button></div>
    <div class="groep"><h3><span>Vastgezet</span></h3>
      <button class="lrij" data-goto="lijst"><span class="licoon boodschap" aria-hidden="true"></span><span class="lnaam">Boodschappen week ${weeknr(S.week)}<small>Uit het weekmenu</small></span><span class="lteller">${bood}</span></button>
      ${vast.map(rij).join("")}</div>
    <div class="groep"><h3><span>Overige</span></h3>${ander.map(rij).join("") || `<p class="muted">Nog geen andere lijsten.</p>`}</div>`;
}
function viewLijst1(l) {
  const zicht = l.items.filter(i => !(S.verberg && i.klaar));
  const sorteer = (a, b) => (a.klaar - b.klaar) || ((a.deadline || "9") > (b.deadline || "9") ? 1 : -1);
  $("#view").innerHTML = `
    <div class="ag-kop"><button class="link" data-lijst="">‹ Alle lijsten</button><button class="ib" data-lijstinst="${l.id}" aria-label="Lijst instellen">⋯</button></div>
    <h1 style="font-size:1.4rem;margin-bottom:4px">${esc(l.naam)}</h1>
    <p class="muted" style="margin:0 0 12px">${l.items.filter(i => !i.klaar).length} open · ${l.prive ? "privé" : "gedeeld met iedereen"}</p>
    <form class="extra-form lform" id="item-form"><input class="in" id="item-tekst" placeholder="${l.soort === "todo" ? "Nieuwe taak, bv. 'ramen wassen vrijdag'" : "Nieuw item"}" aria-label="Nieuw item" autocomplete="off"><button class="knop">Toevoegen</button></form>
    <div class="groep">${zicht.sort(sorteer).map(i => `<div class="item ${i.klaar ? "af" : ""}"><label style="grid-template-columns:24px 1fr">
        <input type="checkbox" data-litem="${l.id}|${i.id}" ${i.klaar ? "checked" : ""}>
        <span class="wat">${esc(i.tekst)}${(i.lid_id || i.deadline) ? `<span class="voor">${[i.lid_id && lid(i.lid_id) ? lid(i.lid_id).naam : "", i.deadline ? "tegen " + AG.dag(i.deadline).getDate() + " " + MND[AG.dag(i.deadline).getMonth()] : ""].filter(Boolean).join(" · ")}</span>` : ""}</span></label>
        <div class="rechts"><button class="kp" data-litembewerk="${l.id}|${i.id}">Details</button></div></div>`).join("") || `<div class="leegstaat">Leeg. Voeg hierboven het eerste item toe.</div>`}</div>
    <label class="toggle"><input type="checkbox" id="verberg" ${S.verberg ? "checked" : ""}> Afgevinkte verbergen</label>`;
  setTimeout(() => { const f = $("#item-tekst"); if (f && window.innerWidth >= 700) f.focus(); });
}
function openLijstInst(id) {
  const l = id ? S.lijsten.find(x => x.id === id) : { naam: "", soort: "lijst", prive: false, vast: false };
  openPaneel(`<form id="l-form"><div class="paneel-kop"><h2>${id ? "Lijst instellen" : "Nieuwe lijst"}</h2><button type="button" class="ib" data-sluit aria-label="Sluiten">✕</button></div>
    <div class="stack"><div class="veld"><label for="l-naam">Naam</label><input class="in" id="l-naam" value="${esc(l.naam)}" ${id ? "" : "autofocus"}></div>
    <div class="veld"><label for="l-soort">Soort</label><select class="in" id="l-soort">${LIJSTSOORT.map(([k, n]) => `<option value="${k}" ${k === l.soort ? "selected" : ""}>${n}</option>`).join("")}</select></div>
    <label class="toggle"><input type="checkbox" id="l-prive" ${l.prive ? "checked" : ""}> Privé (enkel voor mij)</label>
    <label class="toggle"><input type="checkbox" id="l-vast" ${l.vast ? "checked" : ""}> Bovenaan vastzetten</label></div>
    <div class="voet">${id ? `<button type="button" class="knop gevaar links" data-wislijst>Verwijderen</button>` : ""}<button type="button" class="knop sec" data-sluit>Annuleren</button><button class="knop">Bewaren</button></div></form>`);
  const p = $("#paneel"); let zeker = false;
  p.onclick = e => { const t = e.target.closest("button"); if (t && "wislijst" in t.dataset) { if (!zeker) { zeker = true; t.textContent = "Zeker? Tik nogmaals"; t.classList.add("zeker"); return; }
    run(async () => { await db.verwijderLijst(id); await herlaadGezin(); S.lijstOpen = null; sluitPaneel(); render(); }); } };
  p.onsubmit = e => { e.preventDefault(); const naam = p.querySelector("#l-naam").value.trim(); if (!naam) return toast("Geef de lijst een naam");
    run(async () => { const nid = await db.bewaarLijst({ ...l, naam, soort: p.querySelector("#l-soort").value, prive: p.querySelector("#l-prive").checked, vast: p.querySelector("#l-vast").checked, eigenaar: l.eigenaar || ik().id });
      await herlaadGezin(); S.lijstOpen = id || nid; sluitPaneel(); S.tab = "lijsten"; render(); }); };
}
function openItemDetails(lid_, iid) {
  const l = S.lijsten.find(x => x.id === lid_), i = l.items.find(x => x.id === iid);
  openPaneel(`<form id="li-form"><div class="paneel-kop"><h2>Item</h2><button type="button" class="ib" data-sluit aria-label="Sluiten">✕</button></div>
    <div class="stack"><div class="veld"><label for="li-tekst">Wat</label><input class="in" id="li-tekst" value="${esc(i.tekst)}"></div>
    <div class="rij"><div class="veld"><label for="li-wie">Wie</label><select class="in" id="li-wie"><option value="">Iemand</option>${S.leden.map(x => `<option value="${x.id}" ${x.id === i.lid_id ? "selected" : ""}>${esc(x.naam)}</option>`).join("")}</select></div>
      <div class="veld"><label for="li-dl">Deadline (komt in de agenda)</label><input class="in" id="li-dl" type="date" value="${i.deadline || ""}"></div></div></div>
    <div class="voet"><button type="button" class="knop gevaar links" data-wisitem>Verwijderen</button><button type="button" class="knop sec" data-sluit>Annuleren</button><button class="knop">Bewaren</button></div></form>`);
  const p = $("#paneel");
  p.onclick = e => { const t = e.target.closest("button"); if (t && "wisitem" in t.dataset) run(async () => { await db.verwijderItem(lid_, iid); await herlaadGezin(); sluitPaneel(); render(); }); };
  p.onsubmit = e => { e.preventDefault(); run(async () => { await db.bewaarItem(lid_, { ...i, tekst: p.querySelector("#li-tekst").value.trim() || i.tekst, lid_id: p.querySelector("#li-wie").value || null, deadline: p.querySelector("#li-dl").value || null }); await herlaadGezin(); sluitPaneel(); render(); }); };
}

/* ---------- Snel toevoegen ---------- */
// "morgen 19u kapper", "vrijdag ramen wassen", "12/11 oudercontact 17u30", "melk" → datum, tijd en rest
function leesSnel(tekst) {
  let t = " " + tekst.trim() + " ", datum = null, tijd = null;
  const vd = AG.iso(new Date());
  const m1 = t.match(/\s(\d{1,2})[u:h.](\d{2})?\s/i) || t.match(/\s(\d{1,2})[u:h]\s/i);
  if (m1 && +m1[1] < 24) { tijd = `${String(m1[1]).padStart(2, "0")}:${m1[2] || "00"}`; t = t.replace(m1[0], " "); }
  const dagen = { maandag: 1, dinsdag: 2, woensdag: 3, donderdag: 4, vrijdag: 5, zaterdag: 6, zondag: 7 };
  const m2 = t.match(/\s(vandaag|vanavond|morgen|overmorgen|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)\s/i);
  if (m2) { const w = m2[1].toLowerCase(); datum = w === "vandaag" || w === "vanavond" ? vd : w === "morgen" ? AG.plus(vd, 1) : w === "overmorgen" ? AG.plus(vd, 2) : AG.plus(vd, ((dagen[w] - AG.weekdag(vd) + 7) % 7) || 7);
    if (w === "vanavond" && !tijd) tijd = "19:00"; t = t.replace(m2[0], " "); }
  const m3 = t.match(/\s(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\s/);
  if (m3) { let y = m3[3] ? +m3[3] : new Date().getFullYear(); if (y < 100) y += 2000; datum = `${y}-${String(m3[2]).padStart(2, "0")}-${String(m3[1]).padStart(2, "0")}`; if (!m3[3] && datum < vd) datum = `${y + 1}${datum.slice(4)}`; t = t.replace(m3[0], " "); }
  return { titel: t.replace(/\s+(om|op|tegen)\s*$/i, "").replace(/\s+/g, " ").trim(), datum, tijd };
}
function openSnel() {
  const todo = S.lijsten.filter(l => l.soort === "todo");
  openPaneel(`<form id="s-form"><div class="paneel-kop"><h2>Snel toevoegen</h2><button type="button" class="ib" data-sluit aria-label="Sluiten">✕</button></div>
    <input class="in" id="s-tekst" placeholder="bv. morgen 19u kapper · melk · vrijdag ramen wassen" autofocus autocomplete="off" aria-label="Wat wil je toevoegen">
    <p class="muted" id="s-uitleg" style="font-size:.88rem;margin:8px 0">Typ iets; de app stelt voor waar het hoort.</p>
    <div class="chips" id="s-soort">${[["afspraak", "Afspraak"], ["taak", "Taak"], ["todo", "To-do"], ["boodschap", "Boodschap"]].map(([k, l]) => `<button type="button" class="chip" data-ssoort="${k}" aria-pressed="false">${l}</button>`).join("")}</div>
    <div class="voet"><button type="button" class="knop sec" data-sluit>Annuleren</button><button class="knop">Toevoegen</button></div></form>`);
  const p = $("#paneel"); let soort = null, gekozen = false;
  const toon = () => {
    const v = leesSnel(p.querySelector("#s-tekst").value);
    if (!gekozen) soort = !v.titel ? null : v.tijd ? "afspraak" : v.datum ? "taak" : "boodschap";
    p.querySelectorAll("[data-ssoort]").forEach(b => b.setAttribute("aria-pressed", b.dataset.ssoort === soort));
    const wanneer = v.datum ? `${AG.dag(v.datum).getDate()} ${MND[AG.dag(v.datum).getMonth()]}${v.tijd ? " om " + v.tijd : ""}` : v.tijd ? "vandaag om " + v.tijd : "";
    p.querySelector("#s-uitleg").textContent = !v.titel ? "Typ iets; de app stelt voor waar het hoort." :
      ({ afspraak: `Afspraak "${v.titel}"${wanneer ? " op " + wanneer : " vandaag"} in agenda Gezin`, taak: `Taak "${v.titel}"${wanneer ? " tegen " + wanneer : " voor vandaag"}`,
         todo: `To-do "${v.titel}" op ${todo[0] ? todo[0].naam : "een nieuwe to-do-lijst"}`, boodschap: `"${v.titel}" op de boodschappenlijst van deze week` })[soort];
  };
  p.oninput = toon;
  p.onclick = e => { const t = e.target.closest("[data-ssoort]"); if (t) { soort = t.dataset.ssoort; gekozen = true; toon(); } };
  p.onsubmit = e => {
    e.preventDefault(); const v = leesSnel(p.querySelector("#s-tekst").value); if (!v.titel) return;
    const vd = AG.iso(new Date());
    run(async () => {
      if (soort === "afspraak") await db.bewaarAfspraak({ titel: v.titel, kalender_id: S.kalenders[0].id, hele_dag: !v.tijd, datum: v.datum || vd, datum_tot: null, start_tijd: v.tijd, eind_tijd: null, plaats: "", notitie: "", deelnemers: [], herhaling: null, uitzonderingen: [], herinnering_min: null });
      else if (soort === "taak") await db.bewaarTaak({ titel: v.titel, deadline: v.datum || vd, tijd: v.tijd, lid_id: S.ik || null, herhaling: null, notitie: "", klaar: [] });
      else if (soort === "todo") { let l = todo[0]; if (!l) { const id = await db.bewaarLijst({ naam: "To Do", soort: "todo", prive: false, vast: true, eigenaar: ik().id }); await herlaadGezin(); l = S.lijsten.find(x => x.id === id); } await db.bewaarItem(l.id, { tekst: v.titel, klaar: false, lid_id: null, deadline: v.datum }); }
      else await db.addExtra(iso(S.week), { naam: v.titel, afdeling: K.afdelingVoor(v.titel) });
      await db.log(({ afspraak: "plande", taak: "maakte taak", todo: "zette op de to-do", boodschap: "zette op de boodschappenlijst" })[soort] + ` '${v.titel}'`);
      await Promise.all([herlaadAgenda(), herlaadGezin(), herlaadWeek()]); sluitPaneel(); render(); toast("Toegevoegd");
    });
  };
}

/* ---------- Testdata ---------- */
function demoGezin(leden) {
  const [C, Sa] = leden.map(l => l.id), I = (tekst, o = {}) => ({ id: uid(), tekst, klaar: false, lid_id: null, deadline: null, ...o });
  const vd = AG.iso(new Date()), uur = h => new Date(Date.now() - h * 3600e3).toISOString();
  return {
    lijsten: [
      { id: uid(), naam: "To Do", soort: "todo", prive: false, vast: true, eigenaar: C, items: [I("Ramen wassen", { lid_id: C, deadline: AG.plus(vd, 5) }), I("Verzekering auto vergelijken", { lid_id: Sa }), I("Fiets naar de fietsenmaker"), I("Kast in de garage opruimen", { klaar: true })] },
      { id: uid(), naam: "Bespreken", soort: "lijst", prive: false, vast: false, eigenaar: Sa, items: [I("Zomervakantie: welke week?"), I("Verjaardagsfeest plannen")] },
      { id: uid(), naam: "Ikea", soort: "boodschap", prive: false, vast: false, eigenaar: C, items: [I("Kapstokhaakjes"), I("Opbergdozen 4x"), I("Waxinelichtjes")] },
      { id: uid(), naam: "Voor verlof", soort: "lijst", prive: false, vast: false, eigenaar: Sa, items: [I("Paspoorten nakijken"), I("Reisverzekering"), I("Zonnecrème")] },
      { id: uid(), naam: "Cadeau-ideeën", soort: "lijst", prive: true, vast: false, eigenaar: C, items: [I("Boek")] }
    ],
    activiteit: [
      { id: uid(), wie: leden[1].naam, wat: "vinkte 'Restafval buitenzetten' af", op: uur(2) }, { id: uid(), wie: leden[0].naam, wat: "plande 'Etentje met vrienden'", op: uur(20) },
      { id: uid(), wie: leden[1].naam, wat: "zette 'Opbergdozen 4x' op Ikea", op: uur(27) }, { id: uid(), wie: leden[0].naam, wat: "koppelde 'spaghetti' aan BONI spaghetti 500g", op: uur(50) }
    ]
  };
}
