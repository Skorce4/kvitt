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
      // Romslig km-vindu i søket (±40k) – strammes til i analysen
      sokUrl += "&mileage_to=" + (kmTall + 40000);
    }

    const html = await hentViaZyte(sokUrl, zyteKey);
    if (!html) return res.status(200).json({ ok: false, grunn: "Fikk ikke søkeresultat fra FINN." });

    const annonser = parseSokeresultat(html);
    if (annonser.length < 3) {
      return res.status(200).json({ ok: false, grunn: "For få sammenlignbare biler funnet.", antall: annonser.length });
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

  // 2) Fjern statistiske uteliggere (urealistisk lave = vrak/feil/feil variant)
  const priser = rene.map((a) => a.pris).sort((x, y) => x - y);
  if (priser.length >= 4) {
    const q1 = persentil(priser, 25);
    const q3 = persentil(priser, 75);
    const iqr = q3 - q1;
    const nedreGrense = q1 - 1.5 * iqr;
    rene = rene.filter((a) => a.pris >= Math.max(nedreGrense, 15000));
  }

  // 2b) Relativt filter mot FEIL MODELLVARIANT: en bil under 45 % av medianen
  //     er nesten alltid en billigere variant som sneik seg inn (f.eks. en vanlig
  //     A180 blandet med A45 AMG), en delebil, eller en feilpriset annonse.
  //     Dette hindrer at "billigste seriøse" blir absurd lav.
  if (rene.length >= 4) {
    const medianAlle = persentil(rene.map((a) => a.pris).sort((x, y) => x - y), 50);
    rene = rene.filter((a) => a.pris >= medianAlle * 0.45);
  }

  if (rene.length < 3) return { antall: rene.length, forFå: true };

  // 3) Km-prioritering: km påvirker pris sterkt, så vi holder vinduet stramt.
  //    Prøv 12k → 20k → 30k. Strekker IKKE lenger enn 30k, for da blir
  //    sammenligningen upålitelig (en bil med 50k km mer er en annen prisklasse).
  let kmVindu = null;
  if (egenKm && egenKm > 0) {
    const medKm = rene.filter((a) => a.km && a.km > 0);
    // Bruk km-filter kun hvis et flertall av bilene faktisk har km-data
    if (medKm.length >= Math.max(3, rene.length * 0.5)) {
      for (const vindu of [12000, 20000, 30000]) {
        const nære = medKm.filter((a) => Math.abs(a.km - egenKm) <= vindu);
        if (nære.length >= 3) { rene = nære; kmVindu = vindu; break; }
      }
      // Innenfor 30k km må vi ha minst 3 – ellers er ikke datagrunnlaget godt nok
      if (!kmVindu) return { antall: 0, forFå: true, grunnKm: true };
    }
    // Hvis for få har km-data, bruker vi alle rene (år-filteret holder dem i sjakk)
  }

  const grunnlag = rene;
  const gP = grunnlag.map((a) => a.pris).sort((x, y) => x - y);

  const snitt = Math.round(gP.reduce((s, p) => s + p, 0) / gP.length);
  const median = Math.round(persentil(gP, 50));
  const nedreKlynge = Math.round(persentil(gP, 25));
  const lavest = gP[0];
  const høyest = gP[gP.length - 1];

  // 4) Vurder selgerens egen pris mot markedet
  let vurdering = null;
  if (egenPris && egenPris > 0) {
    const p = Number(egenPris);
    if (p > snitt * 1.1) vurdering = "over";
    else if (p < nedreKlynge) vurdering = "under";
    else vurdering = "riktig";
  }

  return {
    antall: grunnlag.length,
    antallTotalt: grunnlag.length,
    kmVektet: kmVindu != null,
    kmVindu: kmVindu,
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
