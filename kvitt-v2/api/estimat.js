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
    const { merke, modell, aar, egenPris, egenKm, kontekst, funn } = req.body || {};
    if (!merke || !aar) return res.status(400).json({ ok: false, grunn: "Mangler merke/år." });

    // 1) Hent sammenlignbare biler fra FINN (bredt søk – AI-en sorterer skjønnet)
    const aarNum = parseInt(aar, 10);
    const query = [merke, modell].filter(Boolean).join(" ");
    const sokUrl =
      "https://www.finn.no/mobility/search/car?q=" + encodeURIComponent(query) +
      "&year_from=" + (aarNum - 1) + "&year_to=" + (aarNum + 1) + "&sort=PRICE_ASC";

    const zdbg = [];
    let html = await hentViaZyte(sokUrl, zyteKey, zdbg);
    let annonser = html ? parseSokeresultat(html) : [];
    let kildeHtml = html;
    let soketype = "eksakt";

    // Nivå 2: bredere år hvis få treff
    if (annonser.length < 3) {
      const bredUrl =
        "https://www.finn.no/mobility/search/car?q=" + encodeURIComponent(query) +
        "&year_from=" + (aarNum - 2) + "&year_to=" + (aarNum + 2) + "&sort=PRICE_ASC";
      const html2 = await hentViaZyte(bredUrl, zyteKey, zdbg);
      if (html2) {
        const flere = parseSokeresultat(html2);
        if (flere.length > annonser.length) { annonser = flere; kildeHtml = html2; soketype = "bredt"; }
      }
    }

    // Nivå 3: MODELLFAMILIE. For svært sjeldne biler (ML63, RS6 osv.) finnes det
    // ofte NULL direkte treff – men en innkjøper gir ikke opp der: da prises det
    // fra modellfamilien (ML350/ML500 for en ML63) pluss variant-påslag.
    // Rask-modus (rå HTML) så dette bonus-søket ikke koster full render.
    if (annonser.length < 1) {
      const fam = familieSok(merke, modell);
      if (fam) {
        const famUrl =
          "https://www.finn.no/mobility/search/car?q=" + encodeURIComponent(fam) +
          "&year_from=" + (aarNum - 3) + "&year_to=" + (aarNum + 3) + "&sort=PRICE_ASC";
        const html3 = await hentViaZyte(famUrl, zyteKey, zdbg, { rask: true });
        if (html3) {
          const fFunn = parseSokeresultat(html3);
          if (fFunn.length > 0) { annonser = fFunn; kildeHtml = html3; soketype = "familie"; }
        }
      }
    }

    // Hent km fra synlig korttekst for annonser der JSON-en manglet den
    annonser = berikMedKm(kildeHtml, annonser);

    if (annonser.length < 1) {
      const kvote = zdbg.some((s) => /:(401|402|403)/.test(s));
      return res.status(200).json({
        ok: false,
        grunn: kvote ? "Prisdata-kvoten ser ut til å være brukt opp." : "Fant ingen sammenlignbare biler på FINN.",
        _debug: { fraFinn: 0, soketype, zyte: zdbg },
      });
    }

    // Dedupliser og begrens til 25 (nok kontekst, kontrollert kost)
    const sett = new Set();
    const unike = [];
    for (const a of annonser) {
      const n = a.pris + "|" + (a.tittel || "").slice(0, 60);
      if (!sett.has(n)) { sett.add(n); unike.push(a); }
      if (unike.length >= 25) break;
    }

    // 2) La AI-en vurdere som innkjøper
    const liste = unike.map((a, i) =>
      (i + 1) + ". " + (a.tittel || "Ukjent tittel") + " | " +
      Number(a.pris).toLocaleString("nb-NO") + " kr | " +
      (a.km ? Number(a.km).toLocaleString("nb-NO") + " km" : "km ukjent")
    ).join("\n");

    const funnListe = Array.isArray(funn) && funn.length
      ? "\n- Kjente forhold ved bilen (fra analysen): " + funn.slice(0, 6).join("; ")
      : "";

    const prompt = `Du er en erfaren norsk bruktbilinnkjøper. Estimer reell markedsverdi for denne bilen, basert på aktive FINN-annonser.

BILEN SOM VURDERES:
- Merke/modell: ${merke} ${modell || ""}
- Årsmodell: ${aarNum}
- Kilometerstand: ${egenKm ? Number(egenKm).toLocaleString("nb-NO") + " km" : "ukjent"}
- Selgers pris: ${egenPris ? Number(egenPris).toLocaleString("nb-NO") + " kr" : "ikke oppgitt"}
- Fra annonsen (variant/utstyr): ${(kontekst || "").slice(0, 350)}${funnListe}

AKTIVE FINN-ANNONSER (tittel | pris | km)${soketype === "familie" ? " – MERK: ingen direkte treff på varianten; listen er fra MODELLFAMILIEN" : ""}:
${liste}

METODE – tenk som en innkjøper som skal treffe reell omsetningsverdi:
1. Forkast annonser som er feil variant (f.eks. vanlig A3 når bilen er RS3), skadet/deler, eller åpenbart feilpriset. Annonser med vesentlig lavere km enn bilen som vurderes er IKKE sammenlignbare ankere.
2. Velg de 1-4 annonsene nærmest i variant, utstyr og kilometerstand. Én god match er nok.
3. Annonsepriser er ØNSKEPRISER, ikke salgspriser. Reell omsetning skjer under annonsenivået.
4. Mange FINN-annonser er fra FORHANDLERE, ofte med 3-6 mnd garanti. Forhandlerpriser inkluderer garanti og forbrukerkjøpslov-rettigheter og ligger systematisk 5-15 % over hva samme bil oppnår privat. En privatselger uten garanti må ligge under forhandlernivå for å være konkurransedyktig.
5. Negative forhold ved bilen som vurderes – høy km relativt til de sammenlignbare, mange tidligere eiere, manglende servicehistorikk, mangler i annonsen – trekker verdien ytterligere ned. Ligger bilen øverst i km-spennet blant de sammenlignbare, skal estimatet ligge PÅ eller UNDER den laveste seriøse annonsen.
6. REGELEN VIRKER BEGGE VEIER: har bilen som vurderes KLART LAVERE kilometerstand enn de sammenlignbare, er det et reelt fortrinn som skal prises – da skal estimatet ligge OVER ankernes prisnivå, km-justert opp. Sett aldri markedsverdien på bunnen av spennet når bilen har best km av alle.
7. Km-justering: sjeldne/dyre biler ca. 800-1200 kr per 1000 km, vanlige ca. 400-600 kr.
8. HVIS listen er fra modellfamilien (ingen direkte treff på varianten): estimer fra nærmeste familiemedlemmer og legg til/trekk fra variantens kjente markedspåslag (en AMG/RS/M-variant ligger typisk 30-80 % over standardmodellen avhengig av alder). Sett konfidens "lav" og si i begrunnelsen at det ikke finnes direkte sammenlignbare biler ute nå.

KALIBRERINGSEKSEMPEL 1: En CLA180 med 180 000 km og 10 tidligere eiere vurderes. Sammenlignbare ligger 119 900-135 000 kr, flere fra forhandler med garanti, og laveste har 170 000 km (mindre enn bilen). Riktig estimat: ca. 110 000-120 000 kr – under laveste annonse, fordi bilen ligger øverst i km-spennet, har uvanlig mange eiere, og forhandlerprisene inkluderer garanti en privatselger ikke tilbyr.

KALIBRERINGSEKSEMPEL 2 (motsatt vei): En X5 xDrive45e 2020 med 72 900 km vurderes. Sammenlignbare 2020-modeller ligger 570 000-580 000 kr, men har 97 000-114 000 km – altså 25 000-40 000 km MER enn bilen. Riktig estimat: ca. 600 000-620 000 kr, OVER annonsenivået, fordi bilens lavere km er et fortrinn verdt ca. 800-1000 kr per 1000 km i denne klassen.

I "begrunnelse": si eksplisitt hvordan bilens kilometerstand ligger mot de sammenlignbare (lavere/høyere, og omtrent hvor mye), og hvorfor estimatet derfor ligger over eller under annonsenivået.

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

// Modellfamilie-søk: "ML63" -> "ML", "CLA 180" -> "CLA", "A45 AMG" -> "A".
// Brukes når null direkte treff – bedre å prise fra familien enn å gi opp.
function familieSok(merke, modell) {
  const tok = String(modell || "").trim().split(/\s+/)[0] || "";
  const fam = tok.replace(/\d.*$/, "").trim();
  if (fam.length >= 1) return (merke + " " + fam).trim();
  return merke || null;
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

// Beriker annonser som mangler km: finner prisen som SYNLIG tekst i HTML
// ("579 000 kr") og leser kilometerstanden som står like FØR den i samme
// annonsekort ("2020 · 105 800 km · Plug-in Bensin · 81 km rekkevidde").
// Virker uansett hvor JSON-blobben med prisene ligger i dokumentet.
// Rekkevidde-tall ("82 km") har under 4 sifre og matches ikke.
function berikMedKm(html, annonser) {
  if (!html || !annonser || !annonser.length) return annonser;
  const flat = html.replace(/[\u00a0\u202f]/g, " ");
  const cursor = {}; // flere biler kan ha samme pris – søk videre fra forrige treff
  for (const a of annonser) {
    if (a.km) continue;
    const prisFmt = String(a.pris).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    const fra = cursor[prisFmt] || 0;
    let idx = flat.indexOf(prisFmt + " kr", fra);
    if (idx === -1) idx = flat.indexOf(prisFmt + ",-", fra);
    if (idx === -1) continue;
    cursor[prisFmt] = idx + 1;
    const bak = flat.slice(Math.max(0, idx - 400), idx);
    const treff = [...bak.matchAll(/(\d{1,3}(?: \d{3})+|\d{5,7})\s*km\b/gi)];
    if (treff.length) {
      const km = parseInt(treff[treff.length - 1][1].replace(/\s/g, ""), 10);
      if (km >= 1000 && km <= 500000) a.km = km;
    }
  }
  return annonser;
}

async function hentViaZyte(url, zyteKey, dbg, opts) {
  const rask = opts && opts.rask;
  const kall = async (body) => {
    try {
      const r = await fetch("https://api.zyte.com/v1/extract", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Basic " + Buffer.from(zyteKey + ":").toString("base64"),
        },
        body: JSON.stringify({ url, ...body, geolocation: "NO" }),
      });
      if (!r.ok) return { status: r.status };
      const data = await r.json();
      if (data.browserHtml) return { html: data.browserHtml };
      if (data.httpResponseBody) return { html: Buffer.from(data.httpResponseBody, "base64").toString("utf8") };
      return { status: "tom" };
    } catch (e) {
      return { status: "nett:" + String(e && e.message || e).slice(0, 50) };
    }
  };
  // rask-modus: kun rå HTML (billig/hurtig) – brukes til bonus-søk
  if (rask) {
    const r = await kall({ httpResponseBody: true });
    if (r.html) return r.html;
    if (dbg) dbg.push("zyte-rask:" + r.status);
    return null;
  }
  // 1) Full nettleser-render
  let r = await kall({ browserHtml: true });
  if (r.html) return r.html;
  if (dbg) dbg.push("zyte:" + r.status);
  // 401/402/403 = nøkkel/kvote – ingen vits å prøve mer
  if (r.status === 401 || r.status === 402 || r.status === 403) return null;
  // 2) Rask fallback: rå HTML (FINN-søk er serverrendret, ofte nok)
  r = await kall({ httpResponseBody: true });
  if (r.html) return r.html;
  if (dbg) dbg.push("zyte2:" + r.status);
  return null;
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
        // km kan stå som JSON-felt ("mileage":178700) ELLER som synlig tekst
        // med mellomrom i tallet ("178 700 km"). JSON-feltet søkes rundt treffet;
        // synlig tekst søkes KUN FREMOVER – km står etter annonsens tittel, og et
        // bakovervindu ville grepet forrige bils km.
        const frem = html.slice(m.index, m.index + 600);
        const kmMatch = vindu.match(/\\?"mileage\\?":\\?"?(\d{3,7})/i)
          || frem.match(/(\d{1,3}(?:[\s\u00a0\u202f]\d{3})+|\d{4,7})\s*km/i);
        const km = kmMatch ? parseInt(String(kmMatch[1]).replace(/[\s\u00a0\u202f]/g, ""), 10) : null;
        const nokkel = pris + "|" + tittel.slice(0, 60);
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
