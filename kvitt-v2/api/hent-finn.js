// api/hent-finn.js
// Henter en FINN-annonse fra URL og plukker ut tittel + beskrivelse.
// Forbedret: fyldige headers, __NEXT_DATA__-parsing, JSON-LD, meta-fallback, retry.
// Skjør etter design – FINN kan fortsatt blokkere. Frontend har tekstfelt som fallback.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Bruk POST." });

  // Diagnostikk: sett { url, debug: true } for å få detaljert info om hvert steg
  const debug = req.body && req.body.debug === true;
  const diag = { steg: [], zyteKeyFinnes: false, htmlLengde: 0, brukteMetode: null };

  try {
    const { url } = req.body || {};
    if (!url || !/finn\.no/i.test(url)) {
      return res.status(400).json({ error: "Lim inn en gyldig FINN-lenke." });
    }

    let html = null;
    const zyteKey = process.env.ZYTE_API_KEY;
    diag.zyteKeyFinnes = !!zyteKey;

    if (zyteKey) {
      // Bruk browserHtml direkte. FINN pakker annonseteksten i JS/enkodet data
      // i rå server-HTML (httpResponseBody), men browserHtml kjører siden i en
      // ekte nettleser hos Zyte, så teksten er ferdig rendret og lesbar.
      diag.steg.push("Henter via browserHtml (rendret)");
      html = await hentViaZyte(url, zyteKey, true);
      diag.steg.push("browserHtml ga " + (html ? html.length + " tegn" : "null"));
      diag.brukteMetode = "browserHtml";
    } else {
      diag.steg.push("INGEN Zyte-nøkkel – prøver direkte (blir blokkert av Cloudflare)");
      for (let attempt = 0; attempt < 2 && !html; attempt++) {
        try {
          const r = await fetch(url, { headers: browserHeaders(url) });
          if (r.ok) { html = await r.text(); break; }
        } catch (_) {}
        await new Promise((res2) => setTimeout(res2, 400));
      }
      diag.brukteMetode = "direkte";
    }

    diag.htmlLengde = html ? html.length : 0;
    diag.zyteStatus = SISTE_ZYTE.status;
    diag.zyteFeil = SISTE_ZYTE.feil;

    if (!html) {
      if (debug) return res.status(200).json({ debug: diag });
      return res.status(502).json({ error: "Klarte ikke å hente annonsen fra FINN." });
    }

    // Diagnostikk: hva finnes i HTML-en?
    diag.harNextData = html.includes("__NEXT_DATA__");
    diag.harJsonLd = html.includes("application/ld+json");
    diag.harOgTitle = html.includes("og:title");
    diag.harCloudflare = /just a moment|cf-browser-verification|challenge-platform/i.test(html);

    // Ekstra diagnostikk: vis rå JSON-LD-blokker + og:description
    if (req.body && req.body.rawLd === true) {
      const ldBlokker = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
        .map((m) => m[1].trim().slice(0, 1500));
      const ogDesc = meta(html, "og:description");
      const ogTitle = meta(html, "og:title");
      return res.status(200).json({ rawLd: ldBlokker, ogDesc, ogTitle });
    }

    // Diagnostikk: vis alle beskrivelseskandidater med lengde, for å finne den fulle
    if (req.body && req.body.debugDesc === true) {
      const kand = [];
      const jsonFelt = [...html.matchAll(/"(?:description|adText|bodyHtml|generalText|body)"\s*:\s*"((?:[^"\\]|\\.){40,})"/gi)];
      for (const m of jsonFelt) {
        let tekst;
        try { tekst = JSON.parse('"' + m[1] + '"'); } catch { tekst = m[1]; }
        const ren = decode(stripTags(tekst));
        kand.push({ kilde: "json-felt", lengde: ren.length, start: ren.slice(0, 120), slutt: ren.slice(-80) });
      }
      // Søk også bredere: alle lange tekstblokker som nevner "km" eller "kilometer"
      const kmBlokker = [...html.matchAll(/"([^"\\]{200,}(?:km|kilometer|mil)[^"\\]{0,2000})"/gi)]
        .slice(0, 5)
        .map((m) => ({ kilde: "km-blokk", lengde: m[1].length, start: m[1].slice(0, 120) }));
      return res.status(200).json({ kandidater: kand, kmBlokker });
    }

    const text = extractFromFinn(html);
    diag.uttrukketLengde = text ? text.length : 0;
    diag.uttrukketStart = text ? text.slice(0, 200) : null;

    if (debug) {
      return res.status(200).json({ debug: diag, tekst: text });
    }

    if (!text || text.length < 40) {
      return res.status(422).json({ error: "Fant ikke annonseteksten." });
    }
    return res.status(200).json({ text });
  } catch (e) {
    console.error("FINN-henting feilet:", e);
    if (debug) {
      diag.steg.push("EXCEPTION: " + String(e && e.message || e));
      return res.status(200).json({ debug: diag });
    }
    return res.status(500).json({ error: "Noe gikk galt under henting." });
  }
}

// Global for siste Zyte-respons, kun for diagnostikk
let SISTE_ZYTE = { status: null, feil: null };

// Henter en URL via Zyte API. browser=false gir billig httpResponseBody,
// browser=true gir browserHtml (JS-rendret, dyrere, kommer forbi mer).
// Begge kjører med residential IP + norsk geolokasjon for å unngå Cloudflare-ban.
async function hentViaZyte(url, zyteKey, browser) {
  // Merk: ipType "residential" krever KYC-godkjent Zyte-konto. Vi dropper det
  // og lar Zyte bruke standard datacenter-IP + sin egen anti-ban/Cloudflare-
  // håndtering, som ofte er nok for FINN. browserHtml gir i tillegg JS-rendering.
  const body = browser
    ? { url, browserHtml: true, geolocation: "NO" }
    : { url, httpResponseBody: true, geolocation: "NO" };

  try {
    const r = await fetch("https://api.zyte.com/v1/extract", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(zyteKey + ":").toString("base64"),
      },
      body: JSON.stringify(body),
    });
    SISTE_ZYTE.status = r.status;
    if (!r.ok) {
      SISTE_ZYTE.feil = (await r.text()).slice(0, 300);
      return null;
    }
    const data = await r.json();
    if (browser) return data.browserHtml || null;
    // httpResponseBody kommer base64-kodet
    if (data.httpResponseBody) {
      return Buffer.from(data.httpResponseBody, "base64").toString("utf-8");
    }
    return null;
  } catch (e) {
    SISTE_ZYTE.feil = String(e && e.message || e);
    return null;
  }
}

// Grov sjekk: inneholder HTML-en noe vi kan parse? Brukes til å avgjøre om vi
// må eskalere fra billig httpResponseBody til dyrere browserHtml.
function harInnhold(html) {
  if (!html || html.length < 500) return false;
  return (
    html.includes("__NEXT_DATA__") ||
    html.includes("application/ld+json") ||
    html.includes("og:title")
  );
}

function browserHeaders(url) {
  return {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "nb-NO,nb;q=0.9,no;q=0.8,nn;q=0.7,en;q=0.6",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "Referer": "https://www.finn.no/",
  };
}

function extractFromFinn(html) {
  const parts = [];

  // 1) og:title – har som regel "Merke Modell - år - farge - hk - karosseri"
  const ogTitle = meta(html, "og:title");
  if (ogTitle) parts.push(ogTitle);

  // 2) Pris + nøkkeldata fra JSON-LD (Product-blokken)
  const ldMatches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of ldMatches) {
    try {
      const data = JSON.parse(m[1].trim());
      const arr = Array.isArray(data) ? data : [data];
      for (const obj of arr) {
        if (obj && obj["@type"] === "Product") {
          if (obj.offers) {
            const o = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
            if (o && o.price) parts.push("Pris: " + o.price + " " + (o.priceCurrency || "NOK"));
          }
        }
      }
    } catch (_) {}
  }

  // 3) Full annonsetekst. FINN legger beskrivelsen i HTML-en – prøv flere mønstre.
  const full = finnFullBeskrivelse(html);
  if (full) parts.push(full);

  // 4) Fallback: og:description (avkortet, men bedre enn ingenting hvis 3 feiler)
  if (!full) {
    const ogDesc = meta(html, "og:description");
    if (ogDesc) parts.push(ogDesc);
  }

  const seen = new Set();
  const clean = parts
    .map((p) => String(p).replace(/\s+/g, " ").trim())
    .filter((p) => p && !seen.has(p) && seen.add(p));
  return clean.join("\n\n").slice(0, 6000);
}

// Leter etter den fulle annonsebeskrivelsen. Med browserHtml er teksten rendret
// i faktiske HTML-elementer, så vi søker i DOM-strukturen FINN bruker.
function finnFullBeskrivelse(html) {
  const kandidater = [];

  // Mønster A: FINN sin beskrivelsesseksjon (rendret DOM)
  const domMønstre = [
    /data-testid=["'](?:description|ad-description|object-description)["'][^>]*>([\s\S]*?)<\/(?:div|section|article)>/gi,
    /<section[^>]*class=["'][^"']*description[^"']*["'][^>]*>([\s\S]*?)<\/section>/gi,
    /<div[^>]*class=["'][^"']*(?:import-decoration|u-word-break)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
  ];
  for (const re of domMønstre) {
    for (const m of html.matchAll(re)) {
      const ren = decode(stripTags(m[1]));
      if (ren.length > 40) kandidater.push(ren);
    }
  }

  // Mønster B: JSON-felt (rå-HTML fallback)
  const jsonFelt = [...html.matchAll(/"(?:description|adText|bodyHtml|generalText|body)"\s*:\s*"((?:[^"\\]|\\.){40,})"/gi)];
  for (const m of jsonFelt) {
    let tekst;
    try { tekst = JSON.parse('"' + m[1] + '"'); } catch { tekst = m[1]; }
    const ren = decode(stripTags(tekst));
    if (ren.length > 40) kandidater.push(ren);
  }

  // Velg lengste (mest komplett), men kun ekte tekst – ikke CSS/kode
  const ekte = kandidater.filter((k) => !/[{};]\s*$/.test(k) && !/^\s*[.#]/.test(k) && !/:host|display:|width:/.test(k));
  ekte.sort((a, b) => b.length - a.length);
  const beste = ekte[0];
  return beste && beste.length > 40 ? beste : null;
}

// Søk rekursivt i __NEXT_DATA__ etter annonsetittel + beskrivelse
function deepFindAd(obj, depth = 0) {
  const out = { title: "", description: "" };
  if (!obj || depth > 8 || typeof obj !== "object") return out;

  // Vanlige FINN-felt
  const titleKeys = ["title", "heading", "subject"];
  const descKeys = ["description", "bodyHtml", "body", "generalText", "adText"];

  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) {
      if (!out.title && titleKeys.includes(k) && v.length < 200) out.title = decode(stripTags(v));
      if (!out.description && descKeys.includes(k) && v.length > 40) out.description = decode(stripTags(v));
    } else if (v && typeof v === "object") {
      const sub = deepFindAd(v, depth + 1);
      if (!out.title && sub.title) out.title = sub.title;
      if (!out.description && sub.description) out.description = sub.description;
    }
    if (out.title && out.description) break;
  }
  return out;
}

function stripTags(s) { return String(s).replace(/<[^>]+>/g, " "); }

function meta(html, prop) {
  const re = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]+content=["\']([^"\']+)["\']', "i");
  const m = html.match(re);
  return m ? decode(m[1]) : "";
}

function decode(s) {
  return String(s)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&aelig;/gi, "æ").replace(/&oslash;/gi, "ø").replace(/&aring;/gi, "å")
    .replace(/&nbsp;/g, " ").replace(/\\u00e6/g, "æ").replace(/\\u00f8/g, "ø").replace(/\\u00e5/g, "å");
}
