// api/analyser.js
// Vercel serverless-funksjon. Holder API-nøkkelen hemmelig og snakker med Claude.
// Frontend kaller denne på /api/analyser med { text }.
//
// KJERNEENDRING: Diagnose (flags) og annonsetekst (improved) genereres nå i ETT
// samlet kall. De subjektive frasene som flagges blir en forbudsliste som den
// forbedrede annonseteksten IKKE får gjenbruke. Det dreper selvmotsigelsen der
// diagnosen advarte mot "strøken" mens annonseteksten samtidig skrev "strøken".

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Bruk POST." });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Mangler ANTHROPIC_API_KEY i miljøvariabler." });
  }

  try {
    const { text } = req.body || {};
    if (!text || text.trim().length < 25) {
      return res.status(400).json({ error: "Annonseteksten er for kort." });
    }

    const system = `Du er Norges fremste ekspert på reklamasjonsrisiko ved privat bilsalg (forbrukerkjøpsloven og kjøpsloven) OG en erfaren annonsetekstforfatter. Du hjelper en privatperson som selger bilen sin, og målet er å redusere selgerens risiko for at kjøper i ettertid kan kreve prisavslag eller heving.

Du returnerer KUN gyldig JSON – ingen markdown, ingen tekst rundt. Du produserer ALT i én sammenheng, og du følger disse ufravikelige reglene:

REGEL 1 – INGEN SELVMOTSIGELSE (viktigst):
Når du i "flags" advarer mot en subjektiv formulering (f.eks. "strøken", "meget godt vedlikeholdt", "bilen er fin", "går som ei kule", "alt man kan ønske seg", "pent brukt"), da er NØYAKTIG den formuleringen forbudt i "improved" og "legal". Du fører selv listen "banned" med disse frasene, og den forbedrede annonseteksten skal være renset for hver eneste av dem. Bryter du dette, har du feilet oppgaven.

REGEL 2 – ERSTATT MED FAKTA:
Subjektive påstander erstattes med konkrete, etterprøvbare opplysninger. "Strøken" → faktisk tilstand ("ingen synlige lakkskader utover to steinsprut på panser"). Mangler fakta, sett inn klammeplassholder [fyll inn ...] som selger fyller ut.

REGEL 3 – ÆRLIGHET REDUSERER RISIKO:
Kjente feil, modifikasjoner (chiptuning, decat, økt ladetrykk, coilovers osv.) og manglende opplysninger (km-stand, årsmodell, servicehistorikk) skal opplyses eksplisitt. Fortiet informasjon er selgerens største risiko.

JSON-struktur du skal returnere:
{
  "score": <0-100, hvor lavt = høy risiko>,
  "label": "<Lav risiko | Moderat risiko | Høy risiko>",
  "blurb": "<2-3 setninger til selgeren om hovedbildet>",
  "banned": ["<eksakt subjektiv frase fra originalen>", ...],
  "flags": [
    { "level": "<bad | warn | ok>", "title": "<kort>", "detail": "<hvorfor dette påvirker reklamasjonsrisiko>" }
  ],
  "reklamasjon": {
    "utfall": "<Prisavslag | Heving | Ingen vesentlig risiko>",
    "eksponering_nok": <heltall eller null>,
    "begrunnelse": "<kort: hvorfor dette utfallet/beløpet>"
  },
  "legal": "<forbeholdstekst klar til å lime nederst i annonsen, uten forbudte fraser>",
  "improved": "<full forbedret annonsetekst klar til FINN, uten en eneste forbudt frase>",
  "questions": [
    { "q": "<spørsmål kjøper sannsynligvis stiller>", "why": "<hvorfor selger bør ha svar klart>" }
  ]
}

Bruk 3-6 flags, 3-5 questions. Skriv alt på norsk.`;

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2500,
        system,
        messages: [
          {
            role: "user",
            content: `Her er FINN-annonsen som skal analyseres:\n\n---\n${text}\n---\n\nReturner den komplette JSON-analysen nå.`,
          },
        ],
      }),
    });

    if (!anthropicRes.ok) {
      const detail = await anthropicRes.text();
      return res.status(502).json({ error: `Analysetjenesten svarte ${anthropicRes.status}.`, detail });
    }

    const data = await anthropicRes.json();
    const raw = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    const parsed = tryggParse(raw);

    // Sikkerhetsnett: rens forbudte fraser hvis modellen skulle glippe.
    // Vi fjerner ikke teksten, men bytter frasen mot en nøytral markør slik at
    // brukeren aldri ser en selvmotsigelse selv i verste fall.
    if (Array.isArray(parsed.banned) && parsed.banned.length) {
      parsed.improved = rensForbudte(parsed.improved, parsed.banned);
      parsed.legal = rensForbudte(parsed.legal, parsed.banned);
    }

    // Frontend leser: score, label, blurb, flags[], legal, improved, questions[]
    // reklamasjon leses av det nye simulator-steget (lagt til i index.html).
    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(500).json({ error: "Klarte ikke å fullføre analysen. Prøv igjen." });
  }
}

function tryggParse(text) {
  let t = (text || "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s !== -1 && e !== -1) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

function rensForbudte(tekst, banned) {
  if (!tekst) return tekst;
  let ut = tekst;
  for (const frase of banned) {
    if (!frase || frase.length < 3) continue;
    const re = new RegExp(frase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    ut = ut.replace(re, "[beskriv konkret]");
  }
  return ut;
}
