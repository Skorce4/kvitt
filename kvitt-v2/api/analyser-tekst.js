// api/analyser-tekst.js
// Andre halvdel av analysen: forbedret annonsetekst + forbehold + spørsmål.
// Kalles ETTER /api/analyser, som allerede har gjort rate-limiting og diagnose.
// Får "banned"-listen fra diagnosen som input, og forbys å bruke de frasene –
// slik unngås selvmotsigelse selv om kallene er splittet for hastighet.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Bruk POST." });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Mangler ANTHROPIC_API_KEY." });

  try {
    const { text, banned } = req.body || {};
    if (!text || text.trim().length < 25) {
      return res.status(400).json({ error: "Annonseteksten er for kort." });
    }

    const bannedListe = Array.isArray(banned) ? banned : [];
    const bannedTekst = bannedListe.length
      ? "\n\nDISSE FRASENE ER FORBUDT å bruke (de ble flagget som subjektive i diagnosen). Bruk dem ALDRI, erstatt med konkrete fakta:\n" +
        bannedListe.map((f) => "• " + f).join("\n")
      : "";

    const tekstPrompt =
`Du er ekspert på norsk privatbilsalg. DU hjelper en privatperson som selger SIN EGEN bil. Annonsen er skrevet i førsteperson av eieren selv – behold det perspektivet («jeg», «eier», «selger»), aldri som om en tredjepart selger.

KRITISK regel:
- ALDRI lov et fremtidig utfall («bør gå gjennom EU-kontroll», «går rett gjennom EU», «vil bestå kontroll»). Slike løfter skaper reklamasjonsrisiko.
- Beskriv kun det eier VET I DAG, med forbehold. Trygge formuleringer:
  • «Ingen kjente feil eller mangler som eier er kjent med per dags dato.»
  • «Etter min vurdering fremstår bilen i god teknisk stand.»
  • «Kjøper oppfordres til å foreta egen vurdering av bilens tilstand.»
- Behold alle fakta fra originalen (merke, km, år, pris).${bannedTekst}

Svar KUN med gyldig JSON, ingen markdown, ingen backticks. Bruk \\n for linjeskift inne i verdiene, aldri ekte linjeskift. Struktur:
{"nyScore":<0-100: en ÆRLIG vurdering av hvor godt beskyttet selgeren ville vært HVIS de bruker den forbedrede teksten OG forbeholdet, og fyller ut alle [fyll inn]-plassholdere. Vær realistisk, ikke optimistisk: en tekst med «solgt som den er»-forbehold, åpenhet om kjente feil og utfylte fakta ligger typisk 82-92. Trekk fra hvis viktige opplysninger fortsatt vil mangle selv etter utfylling. Ikke lov mer enn teksten faktisk fortjener – dette tallet må stemme hvis brukeren limer teksten inn på nytt.>,"legal":"<forbeholdstekst på norsk tilpasset bilen, klar å lime nederst i annonsen. Inkluder 'solgt som den er', oppfordring til visning/prøvekjøring, og en nåtidsbasert formulering om kjente feil. Maks 6 setninger.>","improved":"<forbedret versjon av HELE annonseteksten i eierens førsteperson. Behold alle fakta. Gjør den ryddig, tillitsvekkende og selgende. Ingen forbudte fraser. Mangler info, skriv [fyll inn ...]. Bruk \\n for avsnitt.>","questions":[{"q":"<spørsmål kjøperen sannsynligvis stiller>","why":"<hvorfor selger bør ha svar klart>"}]}
Lag 4-5 questions. Annonse:
"""${text}"""`;

    const raw = await callClaude(apiKey, tekstPrompt, 2600);
    const r = parseJson(raw);

    // Sikkerhetsnett: rens forbudte fraser hvis modellen skulle glippe.
    if (bannedListe.length) {
      r.improved = rensForbudte(r.improved, bannedListe);
      r.legal = rensForbudte(r.legal, bannedListe);
    }

    // Diskré kvittn.no-signatur nederst – gratis distribusjon når teksten limes på FINN.
    if (r.improved && !/kvittn\.no/i.test(r.improved)) {
      r.improved = r.improved.replace(/\s*$/, "") + "\n\n— Annonsen er kvalitetssjekket med kvittn.no";
    }

    return res.status(200).json({
      nyScore: r.nyScore != null ? r.nyScore : null,
      legal: r.legal,
      improved: r.improved,
      questions: r.questions || [],
    });
  } catch (err) {
    console.error("Tekst-analyse-feil:", err);
    return res.status(500).json({ error: "Klarte ikke å lage annonseteksten.", detail: String(err && err.message || err) });
  }
}

function rensForbudte(tekst, banned) {
  if (!tekst) return tekst;
  let ut = tekst;
  for (const frase of banned) {
    if (!frase || String(frase).length < 3) continue;
    const re = new RegExp(String(frase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    ut = ut.replace(re, "[beskriv konkret]");
  }
  return ut;
}

async function callClaude(apiKey, prompt, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error("Anthropic " + r.status + ": " + (await r.text()));
  const data = await r.json();
  if (!data.content || !Array.isArray(data.content)) throw new Error("Tomt svar fra Anthropic");
  return data.content.map((b) => b.text || "").join("").trim();
}

function parseJson(raw) {
  let t = (raw || "").trim().replace(/```json/gi, "").replace(/```/g, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a !== -1 && b !== -1 && b > a) t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch (e) {}
  try { return JSON.parse(escapeControlInStrings(t)); } catch (e) {}
  try {
    let cleaned = escapeControlInStrings(t).replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(cleaned);
  } catch (e) {}
  throw new Error("JSON-parse feilet etter opprydding");
}

function escapeControlInStrings(s) {
  let out = "", inStr = false, prev = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '"' && prev !== "\\") { inStr = false; out += ch; }
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else out += ch;
    } else {
      if (ch === '"') { inStr = true; out += ch; }
      else out += ch;
    }
    prev = ch;
  }
  return out;
}
