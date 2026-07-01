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

    // ETT samlet prompt. Diagnose (flags) og forbedret tekst (improved/legal)
    // lages i SAMME kall, slik at teksten ikke kan motsi diagnosen. Modellen
    // fører selv en "banned"-liste over subjektive fraser den flagger, og de
    // frasene er forbudt i improved/legal.
    const fullPrompt =
`Du er ekspert på norsk privatbilsalg og kjøpsloven. DU snakker direkte til en privatperson som selger SIN EGEN bil og har limt inn FINN-annonsen sin under. Du skal både VURDERE reklamasjonsrisikoen og SKRIVE en forbedret annonse – i samme svar, som en sammenhengende helhet.

VIKTIG om risikovurderingen (flags):
- Når selger ÅPENT opplyser om noe (kommende EU-kontroll, kjente feil, slitasje, tidligere skader), er det POSITIVT (level "ok") – åpenhet reduserer reklamasjonsrisiko. Ikke flagg ærlig informasjon som en risiko i seg selv.
- Ekte RISIKO er: manglende «solgt som den er»-forbehold, fortielse av kjente feil, vage superlativer uten dekning, manglende sentrale opplysninger (km, år), eller modifikasjoner/tuning som ikke er opplyst.
- En kommende EU-kontroll er kun en risiko hvis selger LOVER et bestemt utfall («går rett gjennom EU»). Å opplyse om at den skal til kontroll er bra.

DEN VIKTIGSTE REGELEN – INGEN SELVMOTSIGELSE:
Hver subjektiv frase du flagger i "flags" (f.eks. «strøken», «meget godt vedlikeholdt», «går som ei kule», «pent brukt», «alt man kan ønske seg») skal du føre opp i listen "banned". Disse frasene er ABSOLUTT FORBUDT å bruke i "improved" og "legal". Du kan ikke advare mot en formulering og samtidig bruke den selv. Erstatt den med konkrete, etterprøvbare fakta i stedet. Mangler fakta, skriv [fyll inn ...].

KRITISK regel for improved og legal:
- Behold eierens førsteperson («jeg», «eier», «selger»), aldri som om en tredjepart selger.
- ALDRI lov et fremtidig utfall («bør gå gjennom EU-kontroll», «går rett gjennom EU», «vil bestå kontroll»). Slike løfter skaper reklamasjonsrisiko.
- Beskriv kun det eier VET I DAG, med forbehold. Trygge formuleringer:
  • «Ingen kjente feil eller mangler som eier er kjent med per dags dato.»
  • «Etter min vurdering fremstår bilen i god teknisk stand.»
  • «Kjøper oppfordres til å foreta egen vurdering av bilens tilstand.»
- Behold alle fakta fra originalen (merke, km, år, pris).

Svar KUN med gyldig JSON, ingen markdown, ingen backticks. Bruk \\n for linjeskift inne i verdiene, aldri ekte linjeskift. Struktur:
{"score":<0-100, 100=best beskyttet>,"label":"<Høy risiko | Moderat risiko | Godt beskyttet>","blurb":"<1-2 setninger til selgeren, tiltal med 'du'>","banned":["<eksakt subjektiv frase fra originalen>"],"flags":[{"level":"bad|warn|ok","title":"<kort>","detail":"<en setning>"}],"reklamasjon":{"utfall":"<Prisavslag | Heving | Ingen vesentlig risiko>","eksponering_nok":<heltall eller null>,"begrunnelse":"<kort begrunnelse>"},"legal":"<forbeholdstekst, maks 6 setninger, uten forbudte fraser>","improved":"<forbedret annonsetekst i førsteperson, uten en eneste forbudt frase, bruk \\n for avsnitt>","questions":[{"q":"<spørsmål kjøperen stiller>","why":"<hvorfor selger bør ha svar klart>"}]}
Lag 4-6 flags og 4-5 questions. Annonse:
"""${text}"""`;

    const raw = await callClaude(apiKey, fullPrompt, 3200);
    const r = parseJson(raw);

    // Sikkerhetsnett: dersom modellen tross alt gjenbruker en forbudt frase,
    // bytt den ut før den når brukeren. Da ser brukeren aldri en selvmotsigelse.
    if (Array.isArray(r.banned) && r.banned.length) {
      r.improved = rensForbudte(r.improved, r.banned);
      r.legal = rensForbudte(r.legal, r.banned);
    }

    // Legg til en diskré signatur nederst i annonseteksten. Følger med når
    // selger kopierer teksten til FINN – gratis distribusjon for Kvittn.
    if (r.improved && !/kvittn\.no/i.test(r.improved)) {
      r.improved = r.improved.replace(/\s*$/, "") + "\n\n— Annonsen er kvalitetssjekket med kvittn.no";
    }

    return res.status(200).json({
      score: r.score,
      label: r.label,
      blurb: r.blurb,
      flags: r.flags,
      reklamasjon: r.reklamasjon || null,
      legal: r.legal,
      improved: r.improved,
      questions: r.questions || [],
    });
  } catch (err) {
    console.error("Analyse-feil:", err);
    return res.status(500).json({ error: "Klarte ikke å fullføre analysen.", detail: String(err && err.message || err) });
  }
}

// Bytter ut forbudte fraser (fra "banned") med en nøytral markør.
// Sikkerhetsnett mot selvmotsigelse hvis modellen skulle glippe.
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
