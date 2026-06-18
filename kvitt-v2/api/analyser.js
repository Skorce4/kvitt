// api/analyser.js
// Kaller Claude (holder API-nøkkelen hemmelig) OG øker teller i Supabase.
// Frontend kaller /api/analyser – aldri Anthropic eller Supabase direkte.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Bruk POST." });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Mangler ANTHROPIC_API_KEY." });

  try {
    const { text } = req.body || {};
    if (!text || text.trim().length < 25) {
      return res.status(400).json({ error: "Annonseteksten er for kort." });
    }

    const metaPrompt =
`Du er ekspert på norsk privatbilsalg og kjøpsloven. En privatperson selger bilen sin og har limt inn FINN-annonsen under. Vurder RISIKOEN for at kjøperen kommer tilbake og krever penger (reklamasjon etter kjøpsloven, opplysningsplikt).

Svar KUN med gyldig JSON. Ingen markdown, ingen backticks, ingen tekst rundt. Ikke bruk linjeskift inne i tekstverdiene. Struktur:
{"score":<0-100, 100=best beskyttet>,"label":"<Høy risiko | Moderat risiko | Godt beskyttet>","blurb":"<1-2 setninger til selgeren med 'du'>","flags":[{"level":"bad|warn|ok","title":"<kort>","detail":"<en setning>"}]}
Lag 4-6 flags. Annonse:
"""${text}"""`;

    const textPrompt =
`Du er ekspert på norsk privatbilsalg. Her er en FINN-annonse fra en privatselger. Lag to ting og svar KUN med gyldig JSON, ingen markdown, ingen backticks. Bruk \\n for linjeskift inne i verdiene, aldri ekte linjeskift.
{"legal":"<ferdig forbeholdstekst på norsk tilpasset bilen, klar å lime nederst i annonsen. Inkluder 'solgt som den er', oppfordring til visning/prøvekjøring, og at kjente forhold er opplyst. Maks 6 setninger.>","improved":"<forbedret versjon av HELE annonseteksten. Behold alle fakta fra originalen (merke, km, år, pris). Gjør den ryddig, tillitsvekkende og selgende. Mangler viktig info, skriv [fyll inn ...]. Bruk \\n for avsnitt.>","questions":[{"q":"<spørsmål kjøperen sannsynligvis stiller>","why":"<hvorfor selger bør ha svar klart>"}]}
Lag 4-5 questions. Annonse:
"""${text}"""`;

    const [metaRaw, textRaw] = await Promise.all([
      callClaude(apiKey, metaPrompt, 1200),
      callClaude(apiKey, textPrompt, 2600),
    ]);

    const meta = parseJson(metaRaw);
    const texts = parseJson(textRaw);

    return res.status(200).json({
      score: meta.score,
      label: meta.label,
      blurb: meta.blurb,
      flags: meta.flags,
      legal: texts.legal,
      improved: texts.improved,
      questions: texts.questions || [],
    });
  } catch (err) {
    console.error("Analyse-feil:", err);
    return res.status(500).json({ error: "Klarte ikke å fullføre analysen." });
  }
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
  try { return JSON.parse(t); }
  catch (e) { return JSON.parse(t.replace(/[\u0000-\u001F]+/g, (m) => m.replace(/\n/g, "\\n").replace(/\r/g, "").replace(/\t/g, " "))); }
}
