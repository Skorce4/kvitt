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

    const rl = await fetch(SUPABASE_URL + "/rest/v1/rpc/check_limits", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON,
        "Authorization": "Bearer " + SUPABASE_ANON,
      },
      body: JSON.stringify({ client_ip: clientIp, max_per_ip_hour: 10, max_global_hour: 300 }),
    });
    if (rl.ok) {
      const status = await rl.json();
      if (status === "ip") {
        return res.status(429).json({ error: "Du har sjekket mange annonser den siste timen. Prøv igjen om litt." });
      }
      if (status === "global") {
        return res.status(429).json({ error: "Kvittn har uvanlig mange sjekker akkurat nå. Prøv igjen om noen minutter." });
      }
    }
    // Hvis rate-limit-sjekken feiler teknisk, lar vi forespørselen gå gjennom
    // (vi vil ikke blokkere ekte brukere hvis Supabase er nede).
  } catch (e) {
    // stille fallthrough – ikke blokker på teknisk feil
  }

  try {
    const { text } = req.body || {};

    // ── VALIDERTE REFERANSETALL ──────────────────────────────────────────────
    // Bygg forankrede reklamasjonsposter FØR AI-kallet. Hvert kronebeløp og hver
    // prosent stammer herfra (api/referanse.js), ikke fra språkmodellen. AI-en
    // får listen og markerer bare hvilke poster som er UDEKKET i annonsen.
    const { byggReferanse } = await import("./referanse.js");
    const bildata = trekkBildata(text);
    const referanse = byggReferanse(bildata);
    const refListe = referanse.poster
      .map((p, i) => (i + 1) + ". " + p.omrade + " | typisk kostnad " + p.kostNok.toLocaleString("nb-NO") + " kr | basisrisiko " + p.sannsynlighet + "% | " + p.hvorfor)
      .join("\n");
    if (!text || text.trim().length < 25) {
      return res.status(400).json({ error: "Annonseteksten er for kort." });
    }

    // RASKT diagnose-kall. Returnerer kun score + flags + banned + reklamasjon.
    // Annonsetekst og forbehold hentes separat via /api/analyser-tekst, som får
    // banned-listen herfra som input – slik unngås selvmotsigelse selv om kallene
    // er splittet. Splittingen lar frontend vise scoren på halve tiden.
    const diagnosePrompt =
`Du er ekspert på norsk privatbilsalg og kjøpsloven. DU snakker direkte til en privatperson som selger SIN EGEN bil og har limt inn FINN-annonsen sin under. Vurder reklamasjonsrisikoen.

VIKTIG om risikovurderingen:
- Annonsen kan inneholde en "Fakta:"-seksjon med strukturerte opplysninger (Kilometerstand, Modellår, Girkasse, Drivstoff osv.) hentet fra FINN. Disse teller som OPPGITT informasjon. Ikke flagg noe som "mangler" hvis det står i Fakta-seksjonen – f.eks. hvis "Kilometerstand: 143 000 km" står der, er km oppgitt og skal IKKE flagges som manglende.
- Plassholdere i klammeform som [fyll inn ...] betyr at selgeren skal fylle inn dette FØR publisering. Behandle dem som informasjon som KOMMER til å bli oppgitt – ikke straff scoren for dem og ikke flagg dem som manglende opplysninger. Vurder teksten som om plassholderne blir fylt ut.
- BELØNN ÅPENHET. Når en annonse NEVNER en svakhet åpent (rust, høy km, kjente feil, tidligere skader, modifikasjoner), er det POSITIVT og skal gi HØYERE score – ikke lavere. Åpenhet reduserer reklamasjonsrisiko fordi kjøper ikke kan hevde å ha blitt villedet. En ærlig, detaljert annonse som nevner rust skal score HØYERE enn en vag annonse som skjuler den. Ikke forveksle "nevner en risiko" (bra) med "har en skjult risiko" (dårlig).
- GJENKJENN «solgt som den er»-forbehold i ALLE former. Formuleringer som «selges som den er», «solgt som den er», «selges as-is», eller en forbeholdstekst som fraskriver ansvar for ukjente feil – alle teller som at forbeholdet ER til stede. Ikke flagg «mangler solgt som den er» hvis noen slik formulering finnes noe sted i teksten, uansett hvor kort eller hvor den står.
- Når selger ÅPENT opplyser om noe (kommende EU-kontroll, kjente feil, slitasje, tidligere skader), er det POSITIVT (level "ok") – åpenhet reduserer reklamasjonsrisiko. Ikke flagg ærlig informasjon som en risiko i seg selv.
- Ekte RISIKO er: manglende «solgt som den er»-forbehold, fortielse av kjente feil, vage superlativer uten dekning, manglende sentrale opplysninger (km, år), eller modifikasjoner/tuning som ikke er opplyst.
- En kommende EU-kontroll er kun en risiko hvis selger LOVER et bestemt utfall («går rett gjennom EU»). Å opplyse om at den skal til kontroll er bra.

Hver subjektiv frase du flagger (f.eks. «strøken», «meget godt vedlikeholdt», «går som ei kule», «pent brukt», «alt man kan ønske seg») skal du føre opp i listen "banned". Denne listen brukes senere til å skrive en forbedret annonse uten disse frasene, så vær nøyaktig.

MODELLSVAKHETER: Basert på bilens merke, modell, årgang og motor/girkasse, list kjente svakheter eller vanlige feilpunkter for nettopp denne modellen (f.eks. DSG-mekatronikk på VW, EGR/partikkelfilter på visse dieselmotorer, kjedestrekk, kjente rustpunkter). Dette hjelper selgeren være åpen om det og unngå reklamasjon. Vær konkret og faglig – kun reelle kjente svakheter, ikke gjett vilt. Kjenner du ingen spesifikke svakheter, returner tom liste.

VALIDERTE REFERANSETALL – SVÆRT VIKTIG:
Nedenfor er en liste over reklamasjonsområder for nettopp denne bilen, med FASTE kostnads- og risikotall hentet fra Kvitt'ns referansedatabase. Du skal IKKE finne på egne kronebeløp eller prosenter – du skal BRUKE disse tallene. Din jobb er å vurdere, for hvert område, om annonsen ALLEREDE opplyser åpent om forholdet (da er risikoen lav – kjøper er informert) eller om det er UDEKKET (da gjelder basisrisikoen).

Referanseområder for denne bilen:
${refListe}

Regler for bruk:
- I "skadeRisiko": ta med områdene over. Bruk områdenavnet og kostnaden UENDRET. For sannsynlighet: bruk basisrisikoen som utgangspunkt, men SETT NED mot 3-5% hvis annonsen åpent opplyser om forholdet (åpenhet reduserer krav). Ikke øk over basis.
- I "reklamasjon.eksponering_nok": summer kostnaden for de områdene som er UDEKKET i annonsen (rund til nærmeste 1000). Er alt åpent opplyst, sett et lavt beløp eller null.
- I "reklamasjon.begrunnelse": referer til de konkrete postene og at tallene er basert på Kvitt'ns referansedatabase (bransjeanslag). Nevn hvilke poster som er udekket.

Svar KUN med gyldig JSON, ingen markdown, ingen backticks. Ikke bruk ekte linjeskift inne i verdiene. Struktur:
{"score":<0-100, 100=best beskyttet>,"label":"<Høy risiko | Moderat risiko | Godt beskyttet>","blurb":"<1-2 setninger til selgeren, tiltal med 'du'>","banned":["<eksakt subjektiv frase fra originalen>"],"flags":[{"level":"bad|warn|ok","title":"<kort>","detail":"<en setning>"}],"reklamasjon":{"utfall":"<Prisavslag | Heving | Ingen vesentlig risiko>","eksponering_nok":<heltall, sum av UDEKKEDE referanseposter>,"begrunnelse":"<hvilke referanseposter er udekket og driver summen>"},"skadeRisiko":[{"omrade":"<fra referanselisten>","sannsynlighet":<fra referanse, evt. nedjustert ved åpenhet>,"dekket":<true hvis annonsen opplyser om det, ellers false>,"hvorfor":"<én kort setning>"}],"modellsjekk":[{"punkt":"<kjent svakhet for denne modellen>","hvorfor":"<hvorfor selger bør sjekke/opplyse om dette>"}]}
Lag 4-6 flags og opptil 4 modellsjekk-punkter (tom liste hvis ukjent). Annonse:
"""${text}"""`;

    // ── Cache-sjekk: samme annonse analysert nylig? Servér lagret svar. ──
    // Sparer AI-kall (og penger) hvis noen spammer samme annonse.
    const crypto = await import("node:crypto");
    const cacheKey = crypto.createHash("sha256").update(text.trim().toLowerCase()).digest("hex").slice(0, 40);
    try {
      const cr = await fetch(SUPABASE_URL + "/rest/v1/rpc/get_cache", {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON, "Authorization": "Bearer " + SUPABASE_ANON },
        body: JSON.stringify({ k: cacheKey }),
      });
      if (cr.ok) {
        const cached = await cr.json();
        if (cached && cached.score != null) {
          return res.status(200).json({ ...cached, _text: text, _cache: true });
        }
      }
    } catch (e) { /* cache-miss eller teknisk feil: kjør normalt */ }

    const raw = await callClaude(apiKey, diagnosePrompt, 1400);
    const r = parseJson(raw);

    const svar = {
      score: r.score,
      label: r.label,
      blurb: r.blurb,
      flags: r.flags,
      banned: r.banned || [],
      reklamasjon: r.reklamasjon || null,
      skadeRisiko: flettReferanse(r.skadeRisiko, referanse.poster),
      _refKilde: "Kvitt'n referansedatabase (bransjeanslag)",
      modellsjekk: r.modellsjekk || [],
    };
    // GARANTI: kronebeløpet skal ALLTID være sum av validerte, udekkede poster –
    // aldri et fritt AI-tall. Overstyr det AI-en måtte ha satt.
    const validertSum = beregnEksponering(svar.skadeRisiko);
    if (svar.reklamasjon) {
      svar.reklamasjon.eksponering_nok = validertSum;
      svar.reklamasjon._validert = true;
    }

    // Lagre i cache (uten _text – den er brukerspesifikk og legges på ved retur)
    try {
      await fetch(SUPABASE_URL + "/rest/v1/rpc/set_cache", {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON, "Authorization": "Bearer " + SUPABASE_ANON },
        body: JSON.stringify({ k: cacheKey, r: svar }),
      });
    } catch (e) { /* lagring feilet: ikke kritisk */ }

    return res.status(200).json({ ...svar, _text: text });
  } catch (err) {
    console.error("Analyse-feil:", err);
    const m = String(err && err.message || err);
    let brukervennlig = "Klarte ikke å fullføre analysen. Prøv igjen om et øyeblikk.";
    if (/credit|billing|insufficient|payment|quota/i.test(m)) {
      brukervennlig = "Tjenesten er midlertidig utilgjengelig (kapasitet). Prøv igjen senere.";
    } else if (/ 429|rate|overloaded| 529/i.test(m)) {
      brukervennlig = "Uvanlig mange sjekker akkurat nå. Vent et minutt og prøv igjen.";
    } else if (/ 401| 403|api.?key|authentication/i.test(m)) {
      brukervennlig = "Teknisk feil hos oss. Vi ser på det – prøv igjen senere.";
    }
    return res.status(500).json({ error: brukervennlig, detail: m });
  }
}

// Trekker enkle bildata ut av annonseteksten så referansemotoren kan slå opp.
function trekkBildata(text) {
  const t = String(text || "");
  const finn = (re) => { const m = t.match(re); return m ? m[1].trim() : null; };
  const merkeM = t.match(/\b(Volkswagen|VW|Audi|BMW|Mercedes-Benz|Mercedes|Toyota|Volvo|Tesla|Skoda|Ford|Peugeot|Nissan|Kia|Hyundai|Mazda|Honda|Opel|Renault|Citroen|Porsche|Seat|Suzuki|Subaru|Mitsubishi|Jaguar|Land Rover|Mini|Fiat|Dacia|Polestar)\b/i);
  return {
    merke: merkeM ? merkeM[1] : null,
    modell: finn(/(?:modell|model)[:\s]+([A-Za-z0-9\- ]{2,20})/i),
    motor: finn(/\b(\d\.\d\s?(?:TDI|TSI|TFSI|HDi|BlueHDi|dCi|CDTI|CRDi|PureTech|D4|N47|N57)\w*)\b/i)
      || finn(/\b(TDI|TSI|TFSI|BlueHDi|HDi|dCi|CDTI|CRDi|DSG|AMG|RS\d|M\d)\b/i),
    aar: finn(/\b(19\d{2}|20\d{2})\b/),
    km: finn(/(\d[\d\s.]{3,})\s*km\b/i),
    drivstoff: finn(/\b(diesel|bensin|el|elektrisk|hybrid|ladbar hybrid)\b/i),
    gir: finn(/\b(automat|manuell|DSG|automatgir)\b/i),
    tekst: t.slice(0, 600),
  };
}

// Fletter AI-ens dekket-vurdering med de VALIDERTE tallene fra referansemotoren.
// Kostnad, prosent-basis og kilde kommer ALLTID fra referansen – AI-en kan kun
// påvirke om noe er "dekket" (opplyst i annonsen) og dermed senke prosenten.
function flettReferanse(aiSkade, refPoster) {
  const ai = Array.isArray(aiSkade) ? aiSkade : [];
  return refPoster.map((p) => {
    const treff = ai.find((a) => a && a.omrade && (
      a.omrade.toLowerCase().includes(p.omrade.toLowerCase().slice(0, 8)) ||
      p.omrade.toLowerCase().includes((a.omrade || "").toLowerCase().slice(0, 8))
    ));
    const dekket = treff ? !!treff.dekket : false;
    const sann = dekket ? Math.min(5, p.sannsynlighet) : p.sannsynlighet;
    return {
      omrade: p.omrade,
      sannsynlighet: sann,
      kostNok: p.kostNok,        // ALLTID fra referansen
      kilde: p.kilde,            // sporbar kildemerking
      dekket,
      hvorfor: (treff && treff.hvorfor) || p.hvorfor,
    };
  });
}

// Beregner validert eksponering = sum av UDEKKEDE posters kostnad (rundet).
function beregnEksponering(skade) {
  const udekket = (skade || []).filter((s) => !s.dekket);
  const sum = udekket.reduce((s, p) => s + (p.kostNok || 0), 0);
  return sum > 0 ? Math.round(sum / 1000) * 1000 : null;
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
