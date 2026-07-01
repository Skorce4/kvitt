// api/hent-finn.js
// Henter en FINN-annonse via Zyte (browserHtml, rendret side) og trekker ut
// tittel, pris, faktaboks (km/år/girkasse osv.) og full beskrivelse.
// browserHtml kommer forbi Cloudflare og gir ferdig rendret tekst.
// Frontend har tekstfelt som fallback hvis henting feiler.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Bruk POST." });

  try {
    const { url } = req.body || {};
    if (!url || !/finn\.no/i.test(url)) {
      return res.status(400).json({ error: "Lim inn en gyldig FINN-lenke." });
    }

    let html = null;
    const zyteKey = process.env.ZYTE_API_KEY;

    if (zyteKey) {
      html = await hentViaZyte(url, zyteKey);
    } else {
      // Uten Zyte-nøkkel: prøv direkte (blir som regel blokkert av Cloudflare).
      for (let attempt = 0; attempt < 2 && !html; attempt++) {
        try {
          const r = await fetch(url, { headers: browserHeaders(url) });
          if (r.ok) { html = await r.text(); break; }
        } catch (_) {}
        await new Promise((res2) => setTimeout(res2, 400));
      }
    }

    if (!html) {
      return res.status(502).json({ error: "Klarte ikke å hente annonsen fra FINN." });
    }

    const text = extractFromFinn(html);
    if (!text || text.length < 40) {
      return res.status(422).json({ error: "Fant ikke annonseteksten." });
    }
    const bilder = finnBilder(html);
    return res.status(200).json({ text, bilder });
  } catch (e) {
    console.error("FINN-henting feilet:", e);
    return res.status(500).json({ error: "Noe gikk galt under henting." });
  }
}

// Henter rendret HTML via Zyte browserHtml. Datacenter-IP (residential krever
// KYC-godkjent konto). geolocation NO for norsk visning.
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

function extractFromFinn(html) {
  const parts = [];

  // 1) Tittel (år, farge, hk, karosseri)
  const ogTitle = meta(html, "og:title");
  if (ogTitle) parts.push(ogTitle);

  // 2) Pris fra JSON-LD Product
  const ldMatches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of ldMatches) {
    try {
      const data = JSON.parse(m[1].trim());
      const arr = Array.isArray(data) ? data : [data];
      for (const obj of arr) {
        if (obj && obj["@type"] === "Product" && obj.offers) {
          const o = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
          if (o && o.price) parts.push("Pris: " + o.price + " " + (o.priceCurrency || "NOK"));
        }
      }
    } catch (_) {}
  }

  // 3) Faktaboks (km, år, girkasse, drivstoff osv.) fra dl/dt/dd
  const fakta = finnFaktaboks(html);
  if (fakta) parts.push("Fakta:\n" + fakta);

  // 4) Full beskrivelse
  const full = finnFullBeskrivelse(html);
  if (full) parts.push(full);
  else {
    const ogDesc = meta(html, "og:description");
    if (ogDesc) parts.push(ogDesc);
  }

  const seen = new Set();
  const clean = parts
    .map((p) => String(p).replace(/[ \t]+/g, " ").trim())
    .filter((p) => p && !seen.has(p) && seen.add(p));
  return clean.join("\n\n").slice(0, 6000);
}

// Henter nøkkeldata fra FINN sin faktaboks (definisjonslister).
function finnFaktaboks(html) {
  const linjer = [];
  for (const m of html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)) {
    const k = decode(stripTags(m[1])).trim();
    const v = decode(stripTags(m[2])).trim();
    if (k && v && k.length < 40 && v.length < 80) linjer.push(k + ": " + v);
  }
  return linjer.length ? linjer.join("\n") : null;
}

// Leter etter den fulle annonsebeskrivelsen i rendret HTML.
function finnFullBeskrivelse(html) {
  const kandidater = [];

  const domMonstre = [
    /data-testid=["'](?:description|ad-description|object-description)["'][^>]*>([\s\S]*?)<\/(?:div|section|article)>/gi,
    /<section[^>]*class=["'][^"']*description[^"']*["'][^>]*>([\s\S]*?)<\/section>/gi,
    /<div[^>]*class=["'][^"']*(?:import-decoration|u-word-break)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
  ];
  for (const re of domMonstre) {
    for (const m of html.matchAll(re)) {
      const ren = decode(stripTags(m[1]));
      if (ren.length > 40) kandidater.push(ren);
    }
  }

  const jsonFelt = [...html.matchAll(/"(?:description|adText|bodyHtml|generalText|body)"\s*:\s*"((?:[^"\\]|\\.){40,})"/gi)];
  for (const m of jsonFelt) {
    let tekst;
    try { tekst = JSON.parse('"' + m[1] + '"'); } catch { tekst = m[1]; }
    const ren = decode(stripTags(tekst));
    if (ren.length > 40) kandidater.push(ren);
  }

  // Kun ekte tekst – filtrer bort CSS/kode
  const ekte = kandidater.filter(
    (k) => !/[{};]\s*$/.test(k) && !/^\s*[.#]/.test(k) && !/:host|display:|width:/.test(k)
  );
  ekte.sort((a, b) => b.length - a.length);
  const beste = ekte[0];
  return beste && beste.length > 40 ? beste : null;
}

// Henter bilde-URLer fra FINN JSON-LD (contentUrl) + og:image som fallback.
function finnBilder(html) {
  const urls = [];
  const ldMatches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of ldMatches) {
    try {
      const data = JSON.parse(m[1].trim());
      const arr = Array.isArray(data) ? data : [data];
      for (const obj of arr) {
        if (obj && obj.image) {
          const imgs = Array.isArray(obj.image) ? obj.image : [obj.image];
          for (const img of imgs) {
            const url = typeof img === "string" ? img : (img && img.contentUrl);
            if (url && /finncdn\.no/i.test(url)) urls.push(url);
          }
        }
      }
    } catch (_) {}
  }
  if (!urls.length) {
    const og = meta(html, "og:image");
    if (og) urls.push(og);
  }
  // Dedupliser, maks 6
  return [...new Set(urls)].slice(0, 6);
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

function browserHeaders(url) {
  return {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "nb-NO,nb;q=0.9,no;q=0.8,nn;q=0.7,en;q=0.6",
    "Referer": "https://www.finn.no/",
  };
}
