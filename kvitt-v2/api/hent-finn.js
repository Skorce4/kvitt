// api/hent-finn.js
// Henter en FINN-annonse fra URL og plukker ut tittel + beskrivelse.
// Skjørt etter design: FINN kan blokkere eller endre struktur. Frontend har
// alltid tekstfelt som fallback hvis dette feiler.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Bruk POST." });

  try {
    const { url } = req.body || {};
    if (!url || !/finn\.no/i.test(url)) {
      return res.status(400).json({ error: "Lim inn en gyldig FINN-lenke." });
    }

    // Hent siden med en vanlig nettleser-agent
    const r = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "nb-NO,nb;q=0.9,no;q=0.8,en;q=0.5",
      },
    });

    if (!r.ok) {
      return res.status(502).json({ error: "Klarte ikke å hente annonsen. Lim inn teksten manuelt." });
    }

    const html = await r.text();
    const text = extractFromFinn(html);

    if (!text || text.length < 40) {
      return res.status(422).json({ error: "Fant ikke annonseteksten. Lim inn teksten manuelt." });
    }

    return res.status(200).json({ text });
  } catch (e) {
    console.error("FINN-henting feilet:", e);
    return res.status(500).json({ error: "Noe gikk galt. Lim inn teksten manuelt." });
  }
}

function extractFromFinn(html) {
  let parts = [];

  // 1) Forsøk: JSON-LD strukturert data (mest stabil når den finnes)
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
    } catch (_) { /* ignorer ugyldig JSON */ }
  }

  // 2) Forsøk: og:title + og:description meta-tagger
  if (parts.length === 0) {
    const title = meta(html, "og:title");
    const desc = meta(html, "og:description");
    if (title) parts.push(title);
    if (desc) parts.push(desc);
  }

  // 3) Siste utvei: <title>
  if (parts.length === 0) {
    const t = html.match(/<title>([\s\S]*?)<\/title>/i);
    if (t) parts.push(decode(t[1]));
  }

  // Rydd og slå sammen, fjern duplikater
  const seen = new Set();
  const clean = parts
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p && !seen.has(p) && seen.add(p));

  return clean.join("\n\n").slice(0, 6000);
}

function meta(html, prop) {
  const re = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]+content=["\']([^"\']+)["\']', "i");
  const m = html.match(re);
  return m ? decode(m[1]) : "";
}

function decode(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&aelig;/gi, "æ")
    .replace(/&oslash;/gi, "ø").replace(/&aring;/gi, "å").replace(/&nbsp;/g, " ");
}
