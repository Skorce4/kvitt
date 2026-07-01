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
      diag.steg.push("Zyte-nøkkel funnet, prøver httpResponseBody");
      html = await hentViaZyte(url, zyteKey, false);
      diag.steg.push("httpResponseBody ga " + (html ? html.length + " tegn" : "null"));
      if (!html || !harInnhold(html)) {
        diag.steg.push("Ikke nok innhold, eskalerer til browserHtml");
        html = await hentViaZyte(url, zyteKey, true);
        diag.steg.push("browserHtml ga " + (html ? html.length + " tegn" : "null"));
        diag.brukteMetode = "browserHtml";
      } else {
        diag.brukteMetode = "httpResponseBody";
      }
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
  let parts = [];

  // 1) BEST: __NEXT_DATA__ – moderne FINN legger all data her
  const nextMatch = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextMatch) {
    try {
      const data = JSON.parse(nextMatch[1].trim());
      const found = deepFindAd(data);
      if (found.title) parts.push(found.title);
      if (found.description) parts.push(found.description);
    } catch (_) { /* ignorer */ }
  }

  // 2) JSON-LD strukturert data
  if (parts.length === 0) {
    const ldMatches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const m of ldMatches) {
      try {
        const data = JSON.parse(m[1].trim());
        const arr = Array.isArray(data) ? data : [data];
        for (const obj of arr) {
          if (obj && (obj.name || obj.description)) {
            if (obj.name) parts.push(decode(String(obj.name)));
            if (obj.description) parts.push(decode(String(obj.description)));
          }
        }
      } catch (_) {}
    }
  }

  // 3) og:title + og:description
  if (parts.length === 0) {
    const t = meta(html, "og:title"); if (t) parts.push(t);
    const d = meta(html, "og:description"); if (d) parts.push(d);
  }

  // 4) <title>
  if (parts.length === 0) {
    const t = html.match(/<title>([\s\S]*?)<\/title>/i);
    if (t) parts.push(decode(t[1]));
  }

  const seen = new Set();
  const clean = parts
    .map((p) => String(p).replace(/\s+/g, " ").trim())
    .filter((p) => p && !seen.has(p) && seen.add(p));
  return clean.join("\n\n").slice(0, 6000);
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
