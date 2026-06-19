// api/analyser.js
// Kaller Claude (holder API-nøkkelen hemmelig) OG øker teller i Supabase.
// Frontend kaller /api/analyser – aldri Anthropic eller Supabase direkte.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Bruk POST." });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Mangler ANTHROPIC_API_KEY." });

  // ---- Rate limiting: maks 10 forespørsler per IP per time ----
  // Beskytter mot at noen spammer endepunktet og tømmer Anthropic-kontoen.
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL || "https://anzyovvfyepdonlxyxzc.supabase.co";
    const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFuenlvdnZmeWVwZG9ubHh5eHpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3OTM4MTMsImV4cCI6MjA5NzM2OTgxM30.UMeP9ES9Y4_x_BxZUKVssDLOBNGMIhhc_JtgO50MVaE";
    // Hent IP fra Vercel-headere
    const fwd = req.headers["x-forwarded-for"] || "";
    const clientIp = (Array.isArray(fwd) ? fwd[0] : fwd).split(",")[0].trim() || req.socket?.remoteAddress || "ukjent";

    const rl = await fetch(SUPABASE_URL + "/rest/v1/rpc/check_rate_limit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON,
        "Authorization": "Bearer " + SUPABASE_ANON,
      },
      body: JSON.stringify({ client_ip: clientIp, max_per_hour: 10 }),
    });
    if (rl.ok) {
      const allowed = await rl.json();
      if (allowed === false) {
        return res.status(429).json({ error: "Du har sjekket mange annonser den siste timen. Prøv igjen om litt." });
      }
    }
    // Hvis rate-limit-sjekken feiler teknisk, lar vi forespørselen gå gjennom
    // (vi vil ikke blokkere ekte brukere hvis Supabase er nede).
  } catch (e) {
    // stille fallthrough – ikke blokker på teknisk feil
  }

  try {
    const { text } = req.body || {};
    if (!text || text.trim().length < 25) {
      return res.status(400).json({ error: "Annonseteksten er for kort." });
    }

    const metaPrompt =
`Du er ekspert på norsk privatbilsalg og kjøpsloven. DU snakker direkte til en privatperson som selger SIN EGEN bil og har limt inn FINN-annonsen sin under. Vurder RISIKOEN for at kjøperen kommer tilbake og krever penger (reklamasjon etter kjøpsloven, opplysningsplikt).

VIKTIG om vurderingen:
- Når selger ÅPENT opplyser om noe (f.eks. at bilen snart skal til EU-kontroll, kjente feil, slitasje, tidligere skader), er det POSITIVT (level "ok") – åpenhet reduserer reklamasjonsrisiko. Ikke flagg ærlig informasjon som en risiko i seg selv.
- Ekte RISIKO er det motsatte: manglende «solgt som den er»-forbehold, fortielse av kjente feil, vage superlativer uten dekning, manglende sentrale opplysninger (km, år), eller modifikasjoner/tuning som ikke er opplyst.
- En kommende EU-kontroll er kun en risiko hvis selger LOVER et bestemt utfall (f.eks. «går rett gjennom EU»). Selve det å opplyse om at den skal til kontroll er bra.

Svar KUN med gyldig JSON. Ingen markdown, ingen backticks, ingen tekst rundt. Ikke bruk linjeskift inne i tekstverdiene. Struktur:
{"score":<0-100, 100=best beskyttet>,"label":"<Høy risiko | Moderat risiko | Godt beskyttet>","blurb":"<1-2 setninger til selgeren, tiltal med 'du'>","flags":[{"level":"bad|warn|ok","title":"<kort>","detail":"<en setning>"}]}
Lag 4-6 flags. Annonse:
"""${text}"""`;

    const textPrompt =
`Du er ekspert på norsk privatbilsalg. DU hjelper en privatperson som selger SIN EGEN bil. Annonsen er skrevet i førsteperson av eieren selv – behold det perspektivet («jeg», «eier», «selger»), aldri formuler det som om en tredjepart selger på vegne av noen.

KRITISK regel for den forbedrede teksten og forbeholdet:
- ALDRI lov et fremtidig utfall. Skriv ALDRI noe i retning av at bilen «bør gå gjennom EU-kontroll», «går rett gjennom EU», «vil bestå kontroll» e.l. Slike løfter skaper reklamasjonsrisiko.
- Beskriv i stedet kun det eier FAKTISK VET I DAG, med forbehold. Trygge formuleringer å bruke (velg det som passer, ev. omskriv lett):
  • «Ingen kjente feil eller mangler som eier er kjent med per dags dato.»
  • «Ingen kjente feil som eier er kjent med som bør hindre godkjenning ved EU-kontroll.»
  • «Etter min vurdering fremstår bilen i god teknisk stand.»
  • «Bilen fungerer som normalt og uten kjente mangler av betydning.»
  • «Kjøper oppfordres til å foreta egen vurdering av bilens tilstand.»
- Hvis originalannonsen lover et fremtidig EU-utfall, SKRIV OM det til en slik trygg, nåtidsbasert formulering.

Lag to ting og svar KUN med gyldig JSON, ingen markdown, ingen backticks. Bruk \\n for linjeskift inne i verdiene, aldri ekte linjeskift.
{"legal":"<ferdig forbeholdstekst på norsk tilpasset bilen, klar å lime nederst i annonsen. Inkluder 'solgt som den er', oppfordring til visning/prøvekjøring, og en nåtidsbasert formulering om kjente feil (se reglene over). Maks 6 setninger.>","improved":"<forbedret versjon av HELE annonseteksten i eierens førsteperson. Behold alle fakta fra originalen (merke, km, år, pris). Gjør den ryddig, tillitsvekkende og selgende. Følg KRITISK-regelen over – ingen løfter om fremtidig kontroll. Mangler viktig info, skriv [fyll inn ...]. Bruk \\n for avsnitt.>","questions":[{"q":"<spørsmål kjøperen sannsynligvis stiller>","why":"<hvorfor selger bør ha svar klart>"}]}
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
    return res.status(500).json({ error: "Klarte ikke å fullføre analysen.", detail: String(err && err.message || err) });
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

  // Forsøk 1: rett fram
  try { return JSON.parse(t); } catch (e) {}

  // Forsøk 2: escape kontrolltegn (ekte linjeskift/tab) som ligger INNI strenger
  try { return JSON.parse(escapeControlInStrings(t)); } catch (e) {}

  // Forsøk 3: samme + fjern etterfølgende komma før } eller ]
  try {
    let cleaned = escapeControlInStrings(t).replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(cleaned);
  } catch (e) {}

  // Siste utvei: kast videre med litt kontekst for logging
  throw new Error("JSON-parse feilet etter opprydding");
}

// Går gjennom teksten tegn for tegn og escaper ekte linjeskift, CR og tab
// som befinner seg inne i en JSON-streng (mellom anførselstegn).
function escapeControlInStrings(s) {
  let out = "";
  let inStr = false;
  let prev = "";
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
