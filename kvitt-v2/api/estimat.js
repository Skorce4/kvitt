// api/estimat.js
// AI-drevet verdivurdering: henter sammenlignbare biler fra FINN og lar en
// modell vurdere dem som en erfaren norsk bruktbilinnkjøper – forkaster feil
// varianter, vekter km/år/utstyr, og gir et begrunnet estimat med ankerbiler.
//
// Metodikken speiler hvordan innkjøpere faktisk jobber: aktive annonsepriser
// + faglig skjønn. Krever ANTHROPIC_API_KEY og ZYTE_API_KEY.
// Frontend faller tilbake til /api/prissjekk hvis dette kallet feiler.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Bruk POST." });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const zyteKey = process.env.ZYTE_API_KEY;
  if (!apiKey || !zyteKey) return res.status(200).json({ ok: false, grunn: "Estimat ikke aktivert." });

  try {
    const { merke, modell, aar, egenPris, egenKm, kontekst } = req.body || {};
    if (!merke || !aar) return res.status(400).json({ ok: false, grunn: "Mangler merke/år." });

    // 1) Hent sammenlignbare biler fra FINN (bredt søk – AI-en sorterer skjønnet)
    const aarNum = parseInt(aar, 10);
    const query = [merke, modell].filter(Boolean).join(" ");
    const sokUrl =
      "https://www.finn.no/mobility/search/car?q=" + encodeURIComponent(query) +
      "&year_from=" + (aarNum - 1) + "&year_to=" + (aarNum + 1) + "&sort=PRICE_ASC";

    let html = await hentViaZyte(sokUrl, zyteKey);
    let annonser = html ? parseSokeresultat(html) : [];

    // Fallback: bredere søk hvis få treff
    if (annonser.length < 3) {
      const bredUrl =
        "https://www.finn.no/mobility/search/car?q=" + encodeURIComponent(query) +
        "&year_from=" + (aarNum - 2) + "&year_to=" + (aarNum + 2) + "&sort=PRICE_ASC";
      const html2 = await hentViaZyte(bredUrl, zyteKey);
      if (html2) {
        const flere = parseSokeresultat(html2);
        if (flere.length > annonser.length) annonser = flere;
      }
    }

    if (annonser.length < 1) {
      return res.status(200).json({ ok: false, grunn: "Fant ingen sammenlignbare biler.", _debug: { fraFinn: 0 } });
    }

    // Dedupliser og begrens til 25 (nok kontekst, kontrollert kost)
    const sett = new Set();
    const unike = [];
    for (const a of annonser) {
      const n = a.pris + "|" + (a.tittel || "").slice(0, 30);
      if (!sett.has(n)) { sett.add(n); unike.push(a); }
      if (unike.length >= 25) break;
    }

    // 2) La AI-en vurdere som innkjøper
    const liste = unike.map((a, i) =>
      (i + 1) + ". " + (a.tittel || "Ukjent tittel") + " | " +
      Number(a.pris).toLocaleString("nb-NO") + " kr | " +
      (a.km ? Number(a.km).toLocaleString("nb-NO") + " km" : "km ukjent")
    ).join("\n");

    const prompt = `Du er en erfaren norsk bruktbilinnkjøper. Estimer reell markedsverdi for denne bilen, basert på aktive FINN-annonser.

BILEN SOM VURDERES:
- Merke/modell: ${merke} ${modell || ""}
- Årsmodell: ${aarNum}
- Kilometerstand: ${egenKm ? Number(egenKm).toLocaleString("nb-NO") + " km" : "ukjent"}
- Selgers pris: ${egenPris ? Number(egenPris).toLocaleString("nb-NO") + " kr" : "ikke oppgitt"}
- Fra annonsen (variant/utstyr): ${(kontekst || "").slice(0, 220)}

AKTIVE FINN-ANNONSER (tittel | pris | km):
${liste}

METODE – følg denne som en innkjøper:
1. Forkast annonser som er feil variant (f.eks. vanlig A3 når bilen er RS3), skadet/deler, eller åpenbart feilpriset.
2. Velg de 1-4 annonsene nærmest i variant, utstyr og kilometerstand. Én god match er nok.
3. Juster for km-forskjell: sjeldne/dyre biler ca. 800-1200 kr per 1000 km, vanlige ca. 400-600 kr. Juster skjønnsmessig for årsmodell og utstyr i titlene.
4. Estimatet er REALISTISK OMSETNINGSVERDI – der bilen faktisk kan selges raskt, og der en oppkjøper kan by. Annonsepriser er ønskepriser; reell verdi ligger typisk i nedre del av spennet.

Svar KUN med gyldig JSON, ingenting annet:
{"estimat": tall, "lav": tall, "hoy": tall, "konfidens": "høy"|"middels"|"lav", "ankere": [{"tittel": "...", "pris": tall, "km": tall eller null, "hvorfor": "maks 8 ord"}], "begrunnelse": "1-2 setninger på norsk", "antallVurdert": tall, "antallBrukt": tall}`;

    const svar = await callClaude(apiKey, prompt, 800);
    const data = parseJson(svar);
    if (!data || typeof data.estimat !== "number") {
      return res.status(200).json({ ok: false, grunn: "Kunne ikke tolke estimatet.", _debug: { fraFinn: unike.length } });
    }

    return res.status(200).json({
      ok: true,
      kilde: "ai",
      estimat: Math.round(data.estimat),
      lav: data.lav != null ? Math.round(data.lav) : null,
      hoy: data.hoy != null ? Math.round(data.hoy) : null,
      konfidens: data.konfidens || "middels",
      ankere: Array.isArray(data.ankere) ? data.ankere.slice(0, 4) : [],
      begrunnelse: data.begrunnelse || "",
      antallVurdert: data.antallVurdert || unike.length,
      antallBrukt: data.antallBrukt || (Array.isArray(data.ankere) ? data.ankere.length : 0),
      egenPris: egenPris ? Number(egenPris) : null,
      egenKm: egenKm ? Number(egenKm) : null,
      _debug: { fraFinn: unike.length },
    });
  } catch (err) {
    console.error("Estimat-feil:", err);
    return res.status(200).json({ ok: false, grunn: "Estimat feilet.", detail: String(err && err.message || err) });
  }
}

async function callClaude(apiKey, prompt, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error("Anthropic " + r.status + ": " + (await r.text()).slice(0, 200));
  const data = await r.json();
  if (!data.content || !Array.isArray(data.content)) throw new Error("Tomt svar fra Anthropic");
  return data.content.map((b) => b.text || "").join("").trim();
}

function parseJson(raw) {
  let t = (raw || "").trim().replace(/```json/gi, "").replace(/```/g, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a !== -1 && b !== -1 && b > a) t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch (e) {}
  try { return JSON.parse(t.replace(/[\u0000-\u001f]+/g, " ")); } catch (e) {}
  return null;
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
