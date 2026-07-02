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

    // Bygg FINN-søke-URL. Fritekst på "merke modell" + årsintervall ±2 år.
    // Km-filter: hvis vi kjenner selgerens km, be FINN om biler opp til +50 000 km.
    const aarNum = parseInt(aar, 10);
    const query = [merke, modell].filter(Boolean).join(" ");
    let sokUrl =
      "https://www.finn.no/mobility/search/car?q=" +
      encodeURIComponent(query) +
      "&year_from=" + (aarNum - 2) +
      "&year_to=" + (aarNum + 2) +
      "&sort=PRICE_ASC";
    const kmTall = egenKm ? parseInt(String(egenKm).replace(/\D/g, ""), 10) : null;
    if (kmTall && kmTall > 0) {
      sokUrl += "&mileage_to=" + (kmTall + 50000);
    }

    const html = await hentViaZyte(sokUrl, zyteKey);
    if (!html) return res.status(200).json({ ok: false, grunn: "Fikk ikke søkeresultat fra FINN." });

    // Debug: vis hva vi faktisk fikk, så vi kan fikse parsingen
    if (req.body && req.body.debug === true) {
      const harNext = /__NEXT_DATA__/.test(html);
      const harLd = /application\/ld\+json/.test(html);
      const prisTreff = (html.match(/(\d[\d\s\u00a0]{4,8})\s*kr/gi) || []).slice(0, 10);
      const annonser = parseSokeresultat(html);

      // Hent JSON-LD-blokkene og vis strukturen (nøkler + type) for feilsøking
      const ldBlokker = [];
      const ldMatches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
      for (const m of ldMatches.slice(0, 5)) {
        try {
          const d = JSON.parse(m[1].trim());
          ldBlokker.push({
            type: d["@type"] || (Array.isArray(d) ? "Array[" + d.length + "]" : "?"),
            nøkler: Array.isArray(d) ? ("array av " + d.length) : Object.keys(d).slice(0, 15),
            harItemList: !!d.itemListElement,
            itemListLengde: d.itemListElement ? d.itemListElement.length : 0,
            førsteItem: d.itemListElement && d.itemListElement[0] ? JSON.stringify(d.itemListElement[0]).slice(0, 400) : null,
          });
        } catch (e) { ldBlokker.push({ parseFeil: String(e).slice(0, 80) }); }
      }

      // Finn __NEXT_DATA__ eller andre store JSON-blokker med "price" i seg
      const priceKontekst = [];
      const priceIdx = html.indexOf('"price"');
      if (priceIdx > -1) priceKontekst.push(html.slice(priceIdx - 40, priceIdx + 200));
      const amountIdx = html.indexOf('"amount"');
      if (amountIdx > -1) priceKontekst.push(html.slice(amountIdx - 60, amountIdx + 140));

      return res.status(200).json({
        ok: true, debug: true, sokUrl, htmlLengde: html.length,
        harNextData: harNext, harJsonLd: harLd,
        prisTreffITekst: prisTreff, antallParsed: annonser.length,
        ldBlokker, priceKontekst,
      });
    }

    const annonser = parseSokeresultat(html);
    if (annonser.length < 3) {
      return res.status(200).json({ ok: false, grunn: "For få sammenlignbare biler funnet.", antall: annonser.length });
    }

    const analyse = analyserPriser(annonser, egenPris);
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

  // Match price + priceCurrency NOK + name, i begge escape-former.
  // Vi leter etter price-verdien og det tilhørende name-feltet i samme offers-blokk.
  // Regex fanger: price (tall), og name (tekst) som følger kort etter i samme objekt.
  const patterns = [
    // Escaped: \"price\":\"31941\" ... \"name\":\"Subaru XV\"
    /\\"price\\":\\"(\d{4,7})\\"[\s\S]{0,300}?\\"name\\":\\"([^\\"]{3,60})\\"/g,
    // Ren: "price":"31941" ... "name":"Subaru XV"
    /"price":"(\d{4,7})"[\s\S]{0,300}?"name":"([^"]{3,60})"/g,
    // Pris som tall uten anførselstegn: "price":31941 ... "name":"..."
    /"price":(\d{4,7})[\s\S]{0,300}?"name":"([^"]{3,60})"/g,
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const pris = parseInt(m[1], 10);
      const tittel = (m[2] || "").replace(/\\u[\dA-Fa-f]{4}/g, "").trim();
      if (pris >= 15000 && pris <= 3000000) {
        const nokkel = pris + "|" + tittel.slice(0, 20);
        if (!sett.has(nokkel)) { sett.add(nokkel); ut.push({ pris, tittel, km: null }); }
      }
    }
    if (ut.length >= 3) break; // fant nok med dette mønsteret
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
function analyserPriser(annonser, egenPris) {
  // Dedupliser på pris+tittel
  const unike = [];
  const sett = new Set();
  for (const a of annonser) {
    const nokkel = a.pris + "|" + (a.tittel || "").slice(0, 30);
    if (!sett.has(nokkel)) { sett.add(nokkel); unike.push(a); }
  }

  // 1) Fjern åpenbare vrak via tittel-signaler
  const vrakord = /\b(deler|delebil|skade|skadet|reparasjon|motorfeil|motorhavari|kondemn|defekt|start(er)? ikke|til reparasjon|prosjekt|havarist)\b/i;
  let rene = unike.filter((a) => !vrakord.test(a.tittel || ""));

  // 2) Fjern statistiske uteliggere (urealistisk lave = sannsynlig vrak/feil)
  //    Bruk median og IQR – robust mot ekstremer.
  const priser = rene.map((a) => a.pris).sort((x, y) => x - y);
  if (priser.length >= 4) {
    const q1 = persentil(priser, 25);
    const q3 = persentil(priser, 75);
    const iqr = q3 - q1;
    const nedreGrense = q1 - 1.5 * iqr; // klassisk outlier-grense
    rene = rene.filter((a) => a.pris >= Math.max(nedreGrense, 15000));
  }

  const reneP = rene.map((a) => a.pris).sort((x, y) => x - y);
  if (reneP.length < 3) {
    return { antall: reneP.length, forFå: true };
  }

  // 3) Regn ut markedsbilde
  const snitt = Math.round(reneP.reduce((s, p) => s + p, 0) / reneP.length);
  const median = Math.round(persentil(reneP, 50));
  const nedreKlynge = Math.round(persentil(reneP, 25)); // nedre 25% – billigste seriøse
  const lavest = reneP[0];
  const høyest = reneP[reneP.length - 1];

  // 4) Vurder selgerens egen pris mot markedet (hvis oppgitt)
  let vurdering = null;
  if (egenPris && egenPris > 0) {
    const p = Number(egenPris);
    if (p > snitt * 1.1) vurdering = "over";        // >10% over snitt
    else if (p < nedreKlynge) vurdering = "under";  // under nedre klynge
    else vurdering = "riktig";                       // innenfor markedet
  }

  return {
    antall: reneP.length,
    lavest, høyest, snitt, median, nedreKlynge,
    egenPris: egenPris ? Number(egenPris) : null,
    vurdering,
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
