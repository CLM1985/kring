/* Kring – ingrediëntregels lezen, eenheden normaliseren en producten voorstellen.
   Werkt in de browser (window.KringIngr) en in Node (module.exports). */
(function (root) {
  "use strict";

  // Eenheden: alias → [eenheid, factor]. Gewicht/volume worden later naar g/ml herleid.
  const EENHEID = {
    g: ["g", 1], gr: ["g", 1], "gr.": ["g", 1], gram: ["g", 1], grams: ["g", 1],
    kg: ["kg", 1], kilo: ["kg", 1],
    ml: ["ml", 1], cl: ["cl", 1], dl: ["dl", 1], deciliter: ["dl", 1], l: ["l", 1], liter: ["l", 1],
    el: ["el", 1], eetlepel: ["el", 1], eetlepels: ["el", 1], lepel: ["el", 1], lepels: ["el", 1],
    tl: ["tl", 1], theelepel: ["tl", 1], theelepels: ["tl", 1], kl: ["tl", 1], koffielepel: ["tl", 1], koffielepels: ["tl", 1],
    teentje: ["teentje", 1], teentjes: ["teentje", 1], teen: ["teentje", 1], tenen: ["teentje", 1],
    stuk: ["stuk", 1], stuks: ["stuk", 1], "stuk(s)": ["stuk", 1], st: ["stuk", 1],
    blik: ["blik", 1], blikje: ["blik", 1], blikken: ["blik", 1],
    pak: ["pak", 1], pakje: ["pak", 1], pakjes: ["pak", 1],
    zakje: ["zakje", 1], zakjes: ["zakje", 1], "zakje(s)": ["zakje", 1],
    blokje: ["blokje", 1], blokjes: ["blokje", 1],
    bos: ["bos", 1], bosje: ["bos", 1], bussel: ["bos", 1], bussels: ["bos", 1],
    snuifje: ["snuifje", 1], snufje: ["snuifje", 1],
    scheutje: ["scheutje", 1], scheut: ["scheutje", 1], scheutjes: ["scheutje", 1],
    takje: ["takje", 1], takjes: ["takje", 1],
    sneetje: ["sneetje", 1], sneetjes: ["sneetje", 1], plak: ["sneetje", 1], plakjes: ["sneetje", 1],
    stengel: ["stengel", 1], stengels: ["stengel", 1],
    bol: ["bol", 1], bollen: ["bol", 1],
    plantje: ["plantje", 1], potje: ["potje", 1], potjes: ["potje", 1], bakje: ["bakje", 1],
    stronkje: ["stuk", 1], stronkjes: ["stuk", 1], blaadje: ["stuk", 1], blad: ["stuk", 1],
    klontje: ["klontje", 1], klont: ["klontje", 1], handje: ["handje", 1], toefje: ["toefje", 1],
    vel: ["stuk", 1], rol: ["stuk", 1], flesje: ["fles", 1], fles: ["fles", 1]
  };
  // Omrekening naar basiseenheid voor samentellen
  const BASIS = { g: ["g", 1], kg: ["g", 1000], ml: ["ml", 1], cl: ["ml", 10], dl: ["ml", 100], l: ["ml", 1000] };
  // Eenheden die je telt (afronden naar boven op de lijst)
  const TEL = new Set(["stuk", "teentje", "blik", "pak", "zakje", "blokje", "bos", "sneetje", "stengel", "bol", "plantje", "potje", "bakje", "fles", ""]);
  // Hoeveelheden zonder winkelwaarde: niet optellen
  const VAAG = new Set(["snuifje", "scheutje", "klontje", "handje", "toefje", "takje"]);

  // Basisvoorraad: komt op de lijst onder 'Voorraadkast nakijken'
  const VOORRAAD = ["zout", "peper", "zwarte peper", "witte peper", "olie", "olijfolie", "zonnebloemolie", "arachideolie", "plantaardige olie",
    "water", "boter", "bloem", "suiker", "azijn", "natuurazijn", "nootmuskaat", "paprikapoeder", "currypoeder", "oregano", "tijm",
    "laurier", "rozemarijn", "basilicum (gedroogd)", "kipkruiden", "italiaanse kruiden", "provençaalse kruiden", "cayennepeper",
    "mosterd", "ketchup", "mayonaise", "honing", "bakpapier", "chiliflakes", "kruidnagel", "bicarbonaat"];

  // Regels die geen ingrediënt zijn
  const RUIS = /^(voor \d+ personen|voorbereiding|bereiding|benodigd|ingrediënten|uit jouw keuken|grillpan|bakpapier|vidé)\b/i;

  // Synoniemen en meervoud → sleutel voor samentellen en koppelen
  const SYN = {
    look: "knoflook", ajuin: "ui", ajuinen: "ui", uien: "ui", "gele ui": "ui", "rode uien": "rode ui",
    wortelen: "wortel", wortels: "wortel", worteltjes: "wortel", tomaten: "tomaat", eieren: "ei", "verse eieren": "ei",
    "paprika's": "paprika", "rode paprika's": "rode paprika", courgettes: "courgette", kipfilets: "kipfilet", "kippenfilet": "kipfilet",
    aardappels: "aardappelen", patatten: "aardappelen", "loskokende aardappelen": "bloemige aardappelen", "aardappel": "aardappelen",
    krielaardappelen: "krieltjes", preien: "prei", sjalotten: "sjalot",
    "parmezaanse kaas": "parmezaan", "gran moravia": "parmezaan", "kerstomaatjes": "kerstomaten", cherrytomaten: "kerstomaten",
    "minipruimtomaatjes": "kerstomaten", "tomatenblokjes": "tomatenstukjes", "tomatenpulp": "tomatenstukjes", "geraspte kaas": "gemalen kaas",
    "rundsvlees": "stoofvlees rund", "gemengd gehakt (rund/varken)": "gemengd gehakt", "rund-varkensgehakt": "gemengd gehakt"
  };

  const FRAC = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3 };

  function getal(s) {
    if (s == null) return null;
    s = String(s).trim();
    let m = s.match(/^(\d+)\s*([½¼¾⅓⅔])$/); if (m) return +m[1] + FRAC[m[2]];
    if (FRAC[s] != null) return FRAC[s];
    m = s.match(/^(\d+)\/(\d+)$/); if (m) return +m[1] / +m[2];
    m = s.match(/^(\d+)\s*-\s*(\d+)$/); if (m) return +m[2];               // 275-300 → bovengrens
    if (/^\d{1,3}\.\d{3}$/.test(s)) return +s.replace(".", "");            // 1.000 → 1000
    const n = parseFloat(s.replace(/,\s*/, "."));                          // 0,5 / 0, 5 / 1, 5
    return isFinite(n) ? n : null;
  }

  const NUM = "(\\d+\\s*[½¼¾⅓⅔]|[½¼¾⅓⅔]|\\d+\\/\\d+|\\d+\\s*-\\s*\\d+|\\d{1,3}\\.\\d{3}|\\d+(?:[.,]\\s?\\d+)?)";
  const UNITS = Object.keys(EENHEID).sort((a, b) => b.length - a.length).map(u => u.replace(/[.()]/g, "\\$&")).join("|");
  const RE_VOOR = new RegExp("^" + NUM + "\\s*(?:x\\s+)?(?:(" + UNITS + ")(?![a-zà-ü]))?\\.?\\s*(.*)$", "i");
  const RE_ACHTER = new RegExp("^(.*?)[:\\s]+" + NUM + "\\s*(" + UNITS + ")?\\.?\\s*$", "i");

  function schoon(naam) {
    return naam.replace(/^[•\-–*]+\s*/, "").replace(/\(\(([^)]*)\)\)/g, "($1)").replace(/\s+/g, " ").replace(/^[,:;\s]+|[,:;\s]+$/g, "").trim();
  }

  /** Lees één tekstregel. Geeft {naam, hoeveelheid, eenheid, notitie} of null bij ruis. */
  function lees(regel) {
    let t = schoon(String(regel || ""));
    if (!t || RUIS.test(t)) return null;
    t = t.replace(/^\+{2,}\s*/, "").replace(/^(evt\.|eventueel( ter garnering)?( met)?|naar smaak)\s+/i, "");
    let q = null, u = "", naam = t, notitie = "";
    let m = t.match(RE_VOOR);
    if (m && m[3] !== undefined && (m[2] || /^[a-zà-ü(]/i.test(m[3]))) {
      q = getal(m[1]); u = m[2] ? EENHEID[m[2].toLowerCase()][0] : ""; naam = m[3];
    } else if ((m = t.match(RE_ACHTER)) && m[1] && !/\d$/.test(m[1])) {
      q = getal(m[2]); u = m[3] ? EENHEID[m[3].toLowerCase()][0] : ""; naam = m[1];
    }
    // "1 teentje knoflook" waar eenheid in de naam zit ("2 teentjes teentjes knoflook")
    const dub = naam.match(new RegExp("^(" + UNITS + ")\\s+(.*)$", "i"));
    if (dub && !u) { u = EENHEID[dub[1].toLowerCase()][0]; naam = dub[2]; }
    else if (dub && EENHEID[dub[1].toLowerCase()][0] === u) naam = dub[2];
    // Notitie na komma ("1 ui, fijngesneden") of tussen haakjes aan het einde
    const k = naam.match(/^(.*?),\s*(.+)$/);
    if (k && !/^\d/.test(k[2])) { naam = k[1]; notitie = k[2]; }
    const h = naam.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    if (h && h[1]) { naam = h[1]; notitie = [h[2], notitie].filter(Boolean).join(", "); }
    naam = naam.replace(/\s+(in stukken|fijngesneden|fijngehakt|fijngesnipperd|hardgekookt|verkruimeld|uitgelekt|naar smaak)$/i, m2 => { notitie = notitie || m2.trim(); return ""; });
    naam = schoon(naam);
    if (!naam) return null;
    if (q != null && !u) u = "stuk";
    if (VAAG.has(u)) { notitie = [q != null ? `${fmt(q)} ${u}` : u, notitie].filter(Boolean).join(", "); q = null; u = ""; }
    // Hoofdletter enkel weghalen als het geen eigennaam/merk lijkt ("Tomaat" → "tomaat", "Gran Moravia" blijft)
    if (/^[A-ZÀ-Ü][a-zà-ü]/.test(naam) && !/\s[A-ZÀ-Ü]/.test(naam)) naam = naam.charAt(0).toLowerCase() + naam.slice(1);
    return { naam, hoeveelheid: q, eenheid: u, notitie };
  }

  /** Lees een lijst regels; voegt losse "2 stuks"-regels samen met de vorige naam (FamilyWall-export). */
  function leesLijst(regels) {
    const uit = [];
    for (const r of regels) {
      const s = schoon(r);
      const losseQty = s.match(new RegExp("^" + NUM + "\\s*(" + UNITS + ")?\\.?$", "i"));
      if (losseQty && uit.length && uit[uit.length - 1].hoeveelheid == null) {
        const vorige = uit[uit.length - 1];
        vorige.hoeveelheid = getal(losseQty[1]);
        vorige.eenheid = losseQty[2] ? EENHEID[losseQty[2].toLowerCase()][0] : "stuk";
        continue;
      }
      const i = lees(r); if (i) uit.push(i);
    }
    return uit;
  }

  function sleutel(naam) {
    let s = String(naam || "").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
    s = s.replace(/^(verse?|gedroogde?|grote?|kleine?|middelgrote|jonge|biologische|bio)\s+/, "");
    return SYN[s] || s;
  }
  const isVoorraad = naam => { const k = sleutel(naam); return VOORRAAD.includes(k) || /^(zout|peper)( en (zout|peper))?$|zwarte peper$/.test(k); };

  /** Naar basiseenheid (g/ml) waar mogelijk */
  function basis(q, u) { return (q != null && BASIS[u]) ? [q * BASIS[u][1], BASIS[u][0]] : [q, u]; }

  function minuten(s) {
    if (!s) return null;
    const h = s.match(/(\d+)\s*h/), m = s.match(/(\d+)\s*min/);
    const t = (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0);
    return t || null;
  }

  function fmt(n) { return Number(n).toLocaleString("nl-BE", { maximumFractionDigits: 2 }); }

  // ---------- Productkoppeling ----------
  const MERK = /^(boni|everyday|colruyt|belviva|jordans|dallagiovanna|herta|zandvliet|kiri|philadelphia|chaumes|duyvis|lay's|jimmy's|ijsboerke|iglo|wagner|hoogstraten|hass|zespri|del monte gold|go-tan|come a casa|lotus biscoff|arla|pindos|fama|salakis|vache bleue|deliziosa|carlsbourg|bosto|quaker oats express|devos lemmens|maredsous|bh)\s+/i;
  function productKern(naam) {
    return naam.replace(MERK, "").replace(MERK, "")
      .replace(/\b\d+(?:[.,]\d+)?\s*(x\s*\d+(?:[.,]\d+)?\s*)?(kg|g|ml|cl|l|st|stuks)\b/gi, " ")
      .replace(/[±]/g, " ").replace(/\b(gv|vg|pet|brik|bio)\b/gi, " ").replace(/\s+/g, " ").trim().toLowerCase();
  }
  const woorden = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 1);
  const stam = w => w.replace(/(tjes|jes|je|en|es|s|e)$/, "");
  // Extra zoekwoorden voor ingrediënten waarvan het product anders heet
  const ZOEK = { kerstomaten: "snoeptomaatjes", parmezaan: "oude kaas schilfers", "gemalen kaas": "gratin mix kaas geraspt",
    room: "culinaire room", kookroom: "culinaire room", "verse groene pesto": "groene pesto", krieltjes: "minikrieltjes",
    "witloof": "witloof extra", "ui": "uien", "rode ui": "rode uien", eieren: "scharrelei", ei: "scharrelei", "bladerdeeg": "bladerdeeg",
    melk: "halfvolle melk", aardappelen: "aardappelen matig vastkokend", "bloemige aardappelen": "aardappelen matig vastkokend" };
  const ALGEMEEN = new Set(["pasta", "saus"]);                       // dan telt het woord ervoor
  const GEEN = new Set(["mix", "kruidenmix", "kruid", "kruiden"]);   // kruidenmixen: geen voorstel
  ZOEK.yoghurt = ZOEK["volle yoghurt"] = "griekse yoghurt natuur";
  const ma = (a, b) => a === b || (Math.min(a.length, b.length) >= 5 && Math.min(a.length, b.length) / Math.max(a.length, b.length) >= 0.75 && (a.startsWith(b) || b.startsWith(a)));

  /** Score-gebaseerd voorstel: top-n producten voor een ingrediëntnaam.
      Het hoofdwoord (laatste woord, bv. 'paprika' in 'rode paprika') moet in het product voorkomen. */
  function stelVoor(ingrNaam, producten, n = 3) {
    const sl = sleutel(ingrNaam);
    const k = woorden(ZOEK[sl] || sl).map(stam);
    if (!k.length) return [];
    let hoofd = k[k.length - 1];
    if (GEEN.has(hoofd) || k.some(w => GEEN.has(w))) return [];
    if (ALGEMEEN.has(hoofd)) { if (k.length < 2) return []; hoofd = k[k.length - 2]; }
    return producten.map(p => {
      const w = woorden(p.kern || productKern(p.naam)).map(stam);
      if (!w.some(b => ma(hoofd, b))) return { p, s: 0 };
      let s = 3;
      for (const a of k.slice(0, -1)) if (w.some(b => ma(a, b))) s += 2;
      if (ma(hoofd, w[0])) s += 1;                       // product begint met het hoofdwoord
      s -= Math.max(0, w.length - k.length) * 0.3;      // korte productnamen lichte voorkeur
      if (!p.beschikbaar) s -= 0.5;
      return { p, s };
    }).filter(x => x.s >= 2).sort((a, b) => b.s - a.s).slice(0, n).map(x => x.p);
  }

  /** Aantal verpakkingen + kost voor een benodigde hoeveelheid (basis-eenheid) */
  function verpakkingen(q, u, p) {
    if (!p) return null;
    if (p.prijs_per === "kg") {                         // los per kg
      if (u === "g" && q != null) return { aantal: null, label: `${fmt(q / 1000)} kg`, kost: p.prijs != null ? (q / 1000) * p.prijs : null };
      return { aantal: null, label: "per kg", kost: null };
    }
    let aantal = 1;
    if (q != null && p.inhoud && p.inhoud_eenheid === u) aantal = Math.max(1, Math.ceil(q / p.inhoud - 1e-9));
    else if (q != null && p.inhoud_eenheid === "stuk" && TEL.has(u)) aantal = Math.max(1, Math.ceil(q / (p.inhoud || 1) - 1e-9));
    else if (q != null && TEL.has(u) && !p.inhoud) aantal = Math.max(1, Math.ceil(q - 1e-9));
    return { aantal, label: `${aantal}×`, kost: p.prijs != null ? aantal * p.prijs : null };
  }

  // ---------- Winkelafdeling voorstellen ----------
  const AFD_RE = [
    [/aardappel|krieltje|\bui\b|uien|sjalot|knoflook|^look|wortel|tomaat|tomaten|paprika|courgette|prei|spinazie|^sla|\bsla$|rucola|komkommer|broccoli|bloemkool|kool|witloof|asperge|champignon|selder|peterselie|basilicum|bieslook|koriander|munt|dille|citroen|limoen|appel|peer|pompoen|avocado|boontjes|sperzie|spruit|lente-ui|chilipeper|jalape|veldsla|waterkers|little gem|ijsberg|ajuin/i, "Groenten & fruit"],
    [/gehakt|kip|varken|rund|steak|worst|chipolata|scampi|garnaal|garnalen|zalm|kabeljauw|vis|tonijn|mignonette|spek|pancetta|chorizo|\bham|prosciutto|serrano|lams|kalkoen|mosselen|merguez|schartong/i, "Vlees & vis"],
    [/kaas|parmezaan|gran moravia|mozzarella|burrata|feta|ricotta|mascarpone|cheddar|gruy/i, "Kaas & charcuterie"],
    [/room|melk|yoghurt|boter|\bei\b|eieren|eierdooier/i, "Zuivel & eieren"],
    [/pasta|spaghetti|penne|tagliatel|fettuc|macaroni|farfalle|orzo|couscous|rijst|risotto|spirelli|linguine|tortiglioni|cellentani|capellini|cappelini|bloem|paneermeel|panko|chips|suiker|havervlok|rozijn|pijnboom|zonnebloempit|noten/i, "Droge voeding"],
    [/wrap|tortilla|pita|brood|ciabatta|stokbro|pizzabodem|bladerdeeg|pasteibak|boterham|pistolet/i, "Brood & bakkerij"],
    [/passata|pulp|tomatenstuk|tomatenblok|puree|bouillon|fond|pesto|mayonaise|ketchup|mosterd|saus|azijn|balsamico|olijven|kappertjes|maïs|kokosmelk|honing|stroop|guacamole|tzatziki|sambal|harissa/i, "Conserven & sauzen"],
    [/kruiden|mix|paprikapoeder|curry|nootmuskaat|oregano|tijm|laurier|rozemarijn|peper|zout|kruidnagel|jeneverbes|ras-el|dragon|marjolein|cayenne|chiliflakes|gist|bicarbonaat|olie/i, "Kruiden & specerijen"],
    [/diepvries|frieten|frietjes|nuggets/i, "Diepvries"],
    [/bier|wijn|whisky|\bwater\b/i, "Dranken"]
  ];
  const afdelingVoor = naam => { const s = sleutel(naam) + " " + String(naam || "").toLowerCase(); return (AFD_RE.find(([re]) => re.test(s)) || [, "Andere"])[1]; };
  const zoekLink = naam => "https://www.collectandgo.be/nl/zoek?searchTerm=" + encodeURIComponent(naam);

  const api = { afdelingVoor, zoekLink, lees, leesLijst, sleutel, isVoorraad, basis, minuten, getal, productKern, stelVoor, verpakkingen, TEL, BASIS, EENHEDEN: [...new Set(Object.values(EENHEID).map(x => x[0]))] };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.KringIngr = api;
})(typeof window !== "undefined" ? window : globalThis);
