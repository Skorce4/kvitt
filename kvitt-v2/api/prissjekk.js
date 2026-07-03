// api/prissjekk.js
// Henter sammenlignbare biler fra FINN-søk, filtrerer bort vrak/uteliggere,
// og returnerer markedsbilde: nedre prisklynge (der billigste seriøse ligger)
// + markedssnitt. Selgeren ser begge og kan prise selv.
//
// Krever ZYTE_API_KEY. Kalles fra frontend etter at bil-data er kjent
// (merke, modell, år). Uten disse kan vi ikke søke meningsfullt.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Bruk POST." });

  const zyteKey = process.env.ZYTE_API_KEY;
  if (!zyteKey) return res.status(200).json({ ok: false, grunn: "Prissjekk ikke aktivert" });

  try {
    const { merke, modell, aar, egenPris, egenKm } = req.body || {};
    if (!merke || !aar) {
      return res.status(400).json({ ok: false, grunn: "Mangler merke/år for søk." });
    }

    // Søk BREDT (så vi får nok biler å jobbe med), filtrer STRENGT i koden etterpå.
    // ±1 år og et romslig km-vindu i søket – selve sammenlignbarheten håndteres
    // i analyserPriser, som prioriterer samme år + nær km, men løsner heller på
    // kravet enn å gi brukeren ingenting.
    const aarNum = parseInt(aar, 10);
    const query = [merke, modell].filter(Boolean).join(" ");
    let sokUrl =
      "https://www.finn.no/mobility/search/car?q=" +
      encodeURIComponent(query) +
      "&year_from=" + (aarNum - 1) +
      "&year_to=" + (aarNum + 1) +
      "&sort=PRICE_ASC";
    const kmTall = egenKm ? parseInt(String(egenKm).replace(/\D/g, ""), 10) : null;
    if (kmTall && kmTall > 0) {
      // Romslig km-tak i søket (+60k over din) – strammes/justeres i analysen.
      // Bevisst romslig: bedre å hente for mange og filtrere i koden enn å
      // filtrere bort sammenlignbare biler allerede i FINN-søket.
      sokUrl += "&mileage_to=" + (kmTall + 60000);
    }

    const html = await hentViaZyte(sokUrl, zyteKey);
    if (!html) return res.status(200).json({ ok: false, grunn: "Fikk ikke søkeresultat fra FINN.", _debug: { steg: "zyte-tomt" } });

    let annonser = parseSokeresultat(html);
    // Fallback: fant vi svært få, prøv et bredere søk uten km-tak og med bare merke+modell
    if (annonser.length < 4 && kmTall) {
      const bredUrl =
        "https://www.finn.no/mobility/search/car?q=" +
        encodeURIComponent(query) +
        "&year_from=" + (aarNum - 2) +
        "&year_to=" + (aarNum + 2) +
        "&sort=PRICE_ASC";
      const html2 = await hentViaZyte(bredUrl, zyteKey);
      if (html2) {
        const flere = parseSokeresultat(html2);
        if (flere.length > annonser.length) annonser = flere;
      }
    }

    // Anker-metoden trenger bare ÉN sammenlignbar bil.
    if (annonser.length < 1) {
      return res.status(200).json({ ok: false, grunn: "Fant ingen sammenlignbare biler.", antall: annonser.length, _debug: { fraFinn: annonser.length } });
    }

    const kmForAnalyse = egenKm ? parseInt(String(egenKm).replace(/\D/g, ""), 10) : null;
    const analyse = analyserPriser(annonser, egenPris, kmForAnalyse);
    return res.status(200).json({ ok: true, ...analyse });
  } catch (e) {
    console.error("Prissjekk feilet:", e);
    return res.status(500).json({ ok: false, grunn: "Prissjekk feilet." });
  }
}

async function hentViaZyte(url, zyteKey) {
  try {
    const r = await fetch("https://api.zyte.com/v1/extract", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(zyteKey + ":").toString("base64"),
      },
      body: JSON.stringify({ url, browserHtml: true, geolocation: "NO" }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.browserHtml || null;
  } catch (_) {
    return null;
  }
}

// Parser søkeresultat: henter { pris, tittel, km } per annonse.
// FINN legger annonsedata i JSON (ofte i __NEXT_DATA__ eller JSON-LD ItemList).
// Vi prøver flere strategier for robusthet.
function parseSokeresultat(html) {
  const annonser = [];

  // Strategi 1: __NEXT_DATA__ (FINN sin Next.js-state med strukturert annonseliste)
  const nextMatch = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextMatch) {
    try {
      const data = JSON.parse(nextMatch[1]);
      const funnet = dyptSokEtterAnnonser(data);
      if (funnet.length >= 3) return funnet;
    } catch (_) {}
  }

  // Strategi 2 (HOVED): Hent alle "offers"-objekter direkte fra HTML.
  // FINN legger hver bil som ...,"model":"XV","offers":{"@type":"Offer","price":"31941",
  // "priceCurrency":"NOK",...,"name":"Subaru XV",...}. Vi matcher disse med regex,
  // og henter pris + navn (og km hvis det finnes i nærheten).
  // JSON-en er ofte escaped (\"price\") siden den ligger i en JS-streng, så vi
  // håndterer begge former.
  const offersTreff = hentOffers(html);
  if (offersTreff.length >= 3) return offersTreff;

  // Strategi 3: JSON-LD ItemList (fallback, sjelden på FINN-søk)
  const ldMatches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of ldMatches) {
    try {
      const data = JSON.parse(m[1].trim());
      const arr = Array.isArray(data) ? data : [data];
      for (const obj of arr) {
        if (obj && obj.itemListElement && Array.isArray(obj.itemListElement)) {
          for (const el of obj.itemListElement) {
            const item = el.item || el;
            const pris = item.offers?.price || item.price;
            if (pris) annonser.push({ pris: Number(pris), tittel: item.name || "", km: null });
          }
        }
      }
    } catch (_) {}
  }
  return annonser;
}

// Henter alle bil-annonser ved å matche "offers"-objekter i FINN sin HTML.
// Takler både ren JSON ("price":"31941") og escaped JSON (\"price\":\"31941\").
function hentOffers(html) {
  const ut = [];
  const sett = new Set();

  // Match price + name, i begge escape-former. Vi fanger også km (mileage) hvis
  // det står i nærheten av samme annonse-objekt, for km-vekting.
  const patterns = [
    /\\"price\\":\\"(\d{4,7})\\"[\s\S]{0,300}?\\"name\\":\\"([^\\"]{3,60})\\"/g,
    /"price":"(\d{4,7})"[\s\S]{0,300}?"name":"([^"]{3,60})"/g,
    /"price":(\d{4,7})[\s\S]{0,300}?"name":"([^"]{3,60})"/g,
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const pris = parseInt(m[1], 10);
      const tittel = (m[2] || "").replace(/\\u[\dA-Fa-f]{4}/g, "").trim();
      if (pris >= 15000 && pris <= 3000000) {
        // Let etter km/mileage i et vindu rundt treffet (±400 tegn)
        const start = Math.max(0, m.index - 200);
        const vindu = html.slice(start, m.index + 400);
        const kmMatch = vindu.match(/\\?"mileage\\?":\\?"?(\d{3,7})/i) || vindu.match(/(\d{4,7})\s*km/i);
        const km = kmMatch ? parseInt(kmMatch[1], 10) : null;
        const nokkel = pris + "|" + tittel.slice(0, 20);
        if (!sett.has(nokkel)) { sett.add(nokkel); ut.push({ pris, tittel, km: (km && km < 999999) ? km : null }); }
      }
    }
    if (ut.length >= 3) break;
  }
  return ut;
}

// Går rekursivt gjennom __NEXT_DATA__ og plukker objekter som ligner bilannonser
// (har pris + tittel). FINN endrer struktur av og til, så vi leter bredt.
function dyptSokEtterAnnonser(obj, ut = [], dybde = 0) {
  if (dybde > 8 || !obj || typeof obj !== "object") return ut;
  if (Array.isArray(obj)) {
    for (const el of obj) dyptSokEtterAnnonser(el, ut, dybde + 1);
    return ut;
  }
  // Ser dette objektet ut som en annonse? (pris + heading/title)
  const pris = obj.price?.amount || obj.price || obj.priceAmount;
  const tittel = obj.heading || obj.title || obj.name;
  const km = obj.mileage || obj.km;
  if (pris && tittel && typeof pris === "number" && pris >= 20000 && pris <= 3000000) {
    ut.push({ pris: Number(pris), tittel: String(tittel), km: km ? Number(km) : null });
  }
  for (const k in obj) {
    if (obj[k] && typeof obj[k] === "object") dyptSokEtterAnnonser(obj[k], ut, dybde + 1);
  }
  return ut;
}

// Kjernelogikk: filtrer vrak/uteliggere, regn ut nedre klynge + snitt.
// egenKm: hvis oppgitt, vektes biler nærmest i km-stand (innen 10k) tyngst.
function analyserPriser(annonser, egenPris, egenKm) {
  const _debug = { inn: annonser.length };
  // Dedupliser på pris+tittel
  const unike = [];
  const sett = new Set();
  for (const a of annonser) {
    const nokkel = a.pris + "|" + (a.tittel || "").slice(0, 30);
    if (!sett.has(nokkel)) { sett.add(nokkel); unike.push(a); }
  }
  _debug.etterDedup = unike.length;

  // 1) Fjern åpenbare vrak via tittel-signaler
  const vrakord = /\b(deler|delebil|skade|skadet|reparasjon|motorfeil|motorhavari|kondemn|defekt|start(er)? ikke|til reparasjon|prosjekt|havarist)\b/i;
  let rene = unike.filter((a) => !vrakord.test(a.tittel || ""));
  _debug.etterVrak = rene.length;

  // 2) Fjern statistiske uteliggere – KUN når vi har rikelig data (>=6).
  //    Med få biler er hver bil verdifull; vi filtrerer ikke bort da.
  const priser = rene.map((a) => a.pris).sort((x, y) => x - y);
  if (priser.length >= 6) {
    const q1 = persentil(priser, 25);
    const q3 = persentil(priser, 75);
    const iqr = q3 - q1;
    const nedreGrense = q1 - 1.5 * iqr;
    rene = rene.filter((a) => a.pris >= Math.max(nedreGrense, 15000));
  }

  // 2b) Relativt filter mot FEIL MODELLVARIANT – KUN ved rikelig data (>=6).
  //     Med få biler risikerer dette å fjerne nettopp de vi trenger.
  if (rene.length >= 6) {
    const medianAlle = persentil(rene.map((a) => a.pris).sort((x, y) => x - y), 50);
    rene = rene.filter((a) => a.pris >= medianAlle * 0.45);
  }
  _debug.etterOutlier = rene.length;

  // Vi gir bare opp hvis det ikke finnes en eneste sammenlignbar bil.
  if (rene.length < 1) return { antall: rene.length, forFå: true, _debug };

  // 3) ANKER-METODEN (slik en innkjøper faktisk jobber):
  //    Sorter, finn de 1-3 bilene NÆRMEST din kilometerstand, og bruk dem som
  //    ankeret. Km-juster hver av dem mot din km, så du sammenligner likt.
  //    Én god match holder – da sier vi tydelig at det er basert på få.
  const kmSats = (medPris) => (medPris > 400000 ? 1000 : medPris > 250000 ? 700 : 450);

  let ankere;         // de bilene vi faktisk viser selgeren
  let kmJustert = false;
  const medMedian = persentil(rene.map((a) => a.pris).sort((x, y) => x - y), 50);
  const sats = kmSats(medMedian);

  if (egenKm && egenKm > 0) {
    const medKm = rene.filter((a) => a.km && a.km > 0);
    const utenKm = rene.filter((a) => !a.km || a.km <= 0);
    if (medKm.length >= 1) {
      // Sorter etter km-nærhet til selgerens bil, ta de tre nærmeste
      const sortert = medKm.slice().sort((a, b) => Math.abs(a.km - egenKm) - Math.abs(b.km - egenKm));
      const naermeste = sortert.slice(0, 3);
      // Km-juster hver: en bil med mer km enn din er "for billig" -> juster opp
      ankere = naermeste.map((a) => {
        const diffKm = a.km - egenKm;
        const justering = Math.round((diffKm / 1000) * sats);
        return {
          pris: Math.round(a.pris + justering),   // km-justert pris
          faktiskPris: a.pris,                     // det annonsen faktisk står til
          km: a.km,
          tittel: a.tittel || null,
          kmDiff: diffKm,
          justering,
        };
      });
      kmJustert = ankere.some((a) => a.justering !== 0);
    } else {
      // Ingen km-data i det hele tatt – bruk de rimeligste som anker, ujustert
      ankere = utenKm.slice(0, 3).map((a) => ({ pris: a.pris, faktiskPris: a.pris, km: null, tittel: a.tittel || null, kmDiff: null, justering: 0 }));
    }
  } else {
    // Selgerens km ukjent – vis de tre rimeligste ujustert
    ankere = rene.slice().sort((a, b) => a.pris - b.pris).slice(0, 3)
      .map((a) => ({ pris: a.pris, faktiskPris: a.pris, km: a.km || null, tittel: a.tittel || null, kmDiff: null, justering: 0 }));
  }

  _debug.antallAnkere = ankere.length;
  _debug.kmJustert = kmJustert;

  // MARKEDSVERDI = snittet av ankerbilenes (km-justerte) priser.
  // Med bare 1 anker er det den bilens justerte pris. Dette er der bilen
  // realistisk omsettes, og der en aktør som Rebil kan by.
  const ankerPriser = ankere.map((a) => a.pris).sort((x, y) => x - y);
  const markedsverdi = Math.round(ankerPriser.reduce((s, p) => s + p, 0) / ankerPriser.length);

  // Snitt/spenn fra HELE det rene grunnlaget (kontekst)
  const alle = rene.map((a) => a.pris).sort((x, y) => x - y);
  const snitt = Math.round(alle.reduce((s, p) => s + p, 0) / alle.length);
  const median = Math.round(persentil(alle, 50));
  const lavest = alle[0];
  const høyest = alle[alle.length - 1];

  // 4) Vurder selgerens egen pris mot markedsverdien (anker-basert)
  let vurdering = null;
  if (egenPris && egenPris > 0) {
    const p = Number(egenPris);
    if (p > markedsverdi * 1.08) vurdering = "over";
    else if (p < markedsverdi * 0.95) vurdering = "under";
    else vurdering = "riktig";
  }

  return {
    ok: true,
    antall: rene.length,               // hvor mange sammenlignbare totalt
    antallAnkere: ankere.length,        // hvor mange vi baserer verdien på
    fåBiler: ankere.length < 2,         // flagg: si tydelig at det er basert på få
    ankere,                             // de faktiske bilene selgeren kan se
    kmJustert,
    kmSats: sats,
    markedsverdi,
    nedreKlynge: markedsverdi,          // bakoverkompat med frontend
    snitt, median, lavest, høyest,
    egenPris: egenPris ? Number(egenPris) : null,
    egenKm: egenKm || null,
    vurdering,
    _debug,
  };
}

// Persentil-hjelper (lineær interpolasjon).
function persentil(sortert, p) {
  if (!sortert.length) return 0;
  const idx = (p / 100) * (sortert.length - 1);
  const lav = Math.floor(idx), høy = Math.ceil(idx);
  if (lav === høy) return sortert[lav];
  return sortert[lav] + (sortert[høy] - sortert[lav]) * (idx - lav);
}
