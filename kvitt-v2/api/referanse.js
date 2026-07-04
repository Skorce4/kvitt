// api/referanse.js
// ─────────────────────────────────────────────────────────────────────────────
// REFERANSEMOTOR for reklamasjonsrisiko.
//
// Prinsipp: INGEN sum og INGEN prosent skal noensinne være «funnet på» av en
// språkmodell. Hvert tall som vises til selgeren stammer fra en navngitt regel
// her, med en `kilde`-merkelapp. AI-en gjør bare mønstergjenkjenning (hvilke
// regler er relevante for denne bilen, og er svakheten allerede opplyst i
// annonsen) – tallene kommer herfra.
//
// Tre lag sikrer at ALLE biler dekkes:
//   Lag 1  SPESIFIKKE modellsvakheter (konkret kunnskap, høyest presisjon)
//   Lag 2  GENERISKE regler per drivlinje/alder/km (fanger alt annet)
//   Lag 3  ALDERSBASERT grunnsats (sikkerhetsnett – ingen bil uten tall)
//
// Alle beløp er i NOK og representerer TYPISK utbedrings-/prisavslagsnivå ved en
// reklamasjonssak (kjøpsloven, privatsalg). Sannsynlighet er anslått %-risiko
// for at nettopp dette området utløser et krav innen ~2 år NÅR det ikke er
// opplyst i annonsen.
//
// KILDER (per post): "bransjeanslag" = verkstedsatser + typisk forbrukertvist-
// utfall, kvalifisert startverdi. Skal erstattes/bekreftes med NAF-feilstatistikk,
// EU-kontrolldata og Rebils egne reklamasjonstall etter hvert. `kilde`-feltet
// gjør hver rad sporbar og utskiftbar uten å røre logikken.
// ─────────────────────────────────────────────────────────────────────────────

// ── LAG 1: Spesifikke, kjente modellsvakheter ───────────────────────────────
// match: felt som må finnes i normalisert "merke modell motor"-streng (lowercase).
// aarMin/aarMaks + kmMin: regelen gjelder kun i dette vinduet (utelatt = alltid).
const SPESIFIKKE = [
  {
    id: "vw-dsg-mekatronikk",
    match: ["dsg"], merker: ["volkswagen", "vw", "audi", "skoda", "seat"],
    omrade: "DSG-girkasse (mekatronikk)",
    kostNok: 32000, sannsynlighet: 22,
    kilde: "Kjent svakhet DSG DQ200/DQ250 – bransjeanslag mekatronikk-bytte",
    hvorfor: "Mekatronikkenheten på tørrclutch-DSG er en velkjent feilkilde.",
  },
  {
    id: "bmw-n47-kjede",
    match: ["n47"], merker: ["bmw"],
    omrade: "Registerkjede (N47-motor)",
    kostNok: 28000, sannsynlighet: 25,
    kilde: "Kjent N47-kjedestrekk – bransjeanslag kjede + arbeid",
    hvorfor: "N47-dieselen er beryktet for kjedestrekk, ofte bak motoren.",
  },
  {
    id: "diesel-egr-dpf",
    match: ["tdi", "hdi", "bluehdi", "dci", "cdti", "crdi", "d4", "bluetec"],
    omrade: "EGR / partikkelfilter (DPF)",
    kostNok: 22000, sannsynlighet: 20,
    kilde: "Vanlig dieselfeil EGR/DPF – bransjeanslag rens/bytte",
    hvorfor: "Kjøremønster med mye kortkjøring gir tett EGR/partikkelfilter.",
    aarMaks: 2020,
  },
  {
    id: "mercedes-rust-hjulbue",
    match: [], merker: ["mercedes", "mercedes-benz"],
    omrade: "Rust (hjulbuer / dørkanter)",
    kostNok: 18000, sannsynlighet: 18,
    kilde: "Kjent rustutsatt årgang – bransjeanslag utbedring",
    hvorfor: "Enkelte Mercedes-årganger har kjent rustproblematikk.",
    aarMaks: 2015,
  },
  {
    id: "elbil-12v-batteri",
    match: ["el", "electric", "ev", "e-tron", "id.", "leaf", "zoe", "kona electric", "enyaq", "ioniq"],
    omrade: "12V-batteri / ladeelektronikk",
    kostNok: 14000, sannsynlighet: 15,
    kilde: "Vanlig elbil-servicepunkt – bransjeanslag",
    hvorfor: "12V-systemet og ladeelektronikk er typiske servicepunkter på elbil.",
  },
  {
    id: "amg-rs-m-drivverk",
    match: ["amg", "quattro rs", "rs3", "rs4", "rs5", "rs6", "m2", "m3", "m4", "m5"],
    omrade: "Høyytelses drivverk / clutch",
    kostNok: 45000, sannsynlighet: 16,
    kilde: "Høyytelsesvariant – bransjeanslag drivverk/clutch",
    hvorfor: "Ytelsesbiler har dyrere clutch/drivverk og hardere bruk.",
  },
];

// ── LAG 2: Generiske regler per drivlinje/alder/km ──────────────────────────
// Fanger biler uten spesifikk match. Krever at drivstoff/gir er kjent.
const GENERISKE = [
  {
    id: "gen-diesel-eldre",
    krav: (b) => b.drivstoff === "diesel" && (b.alder >= 6 || b.km >= 150000),
    omrade: "Dieselspesifikk slitasje (EGR/DPF/turbo)",
    kostNok: 18000, sannsynlighet: 17,
    kilde: "Generisk dieselregel (alder/km) – bransjeanslag",
    hvorfor: "Eldre diesel med høy km har økt risiko for EGR/DPF/turbo-feil.",
  },
  {
    id: "gen-automat-hoy-km",
    krav: (b) => b.gir === "automat" && b.km >= 120000,
    omrade: "Automatgirkasse",
    kostNok: 25000, sannsynlighet: 14,
    kilde: "Generisk automatregel (km) – bransjeanslag",
    hvorfor: "Automatgir over 120 000 km har økende risiko for kostbar feil.",
  },
  {
    id: "gen-turbo-bensin",
    krav: (b) => b.drivstoff === "bensin" && b.turbo && (b.alder >= 7 || b.km >= 140000),
    omrade: "Turbo / tenningssystem",
    kostNok: 16000, sannsynlighet: 13,
    kilde: "Generisk turbobensin-regel – bransjeanslag",
    hvorfor: "Eldre turbobensinmotorer får oftere turbo-/tenningsfeil.",
  },
  {
    id: "gen-elbil-generell",
    krav: (b) => b.drivstoff === "el" && b.alder >= 4,
    omrade: "Elbil: ladeelektronikk / 12V",
    kostNok: 13000, sannsynlighet: 12,
    kilde: "Generisk elbilregel (alder) – bransjeanslag",
    hvorfor: "Eldre elbil får typiske feil på ladeelektronikk og 12V-system.",
  },
  {
    id: "gen-hoy-km-slitasje",
    krav: (b) => b.km >= 180000,
    omrade: "Generell slitasje (høy km)",
    kostNok: 15000, sannsynlighet: 15,
    kilde: "Generisk høy-km-regel – bransjeanslag",
    hvorfor: "Over 180 000 km øker risikoen for slitasjerelaterte krav bredt.",
  },
];

// ── LAG 3: Aldersbasert grunnsats (sikkerhetsnett) ──────────────────────────
// Sikrer at ENHVER bil får minst ett forankret tall, selv helt ukjente.
function grunnsats(b) {
  let kost, sann, note;
  if (b.alder <= 3) { kost = 12000; sann = 8; note = "nyere bil, lav baseline"; }
  else if (b.alder <= 8) { kost = 16000; sann = 12; note = "middels alder"; }
  else if (b.alder <= 13) { kost = 20000; sann = 16; note = "eldre bil"; }
  else { kost = 24000; sann = 20; note = "gammel bil, økt baseline"; }
  return {
    id: "grunnsats",
    omrade: "Generell reklamasjonsrisiko",
    kostNok: kost, sannsynlighet: sann,
    kilde: "Aldersbasert grunnsats (" + note + ") – bransjeanslag",
    hvorfor: "Baseline for uspesifisert reklamasjonsrisiko ut fra bilens alder.",
  };
}

// ── Normalisering av bildata fra annonsetekst/fakta ─────────────────────────
function tolkBil({ merke, modell, motor, aar, km, drivstoff, gir, tekst }) {
  const naa = new Date().getFullYear();
  const aarN = parseInt(String(aar || "").replace(/\D/g, ""), 10) || null;
  const t = (tekst || "").toLowerCase();
  const dr = (drivstoff || "").toLowerCase();
  const drivstoffN =
    /\bel\b|elbil|electric|\bev\b/.test(dr + " " + t) ? "el" :
    /diesel|tdi|hdi|dci|cdti|crdi|bluetec/.test(dr + " " + t) ? "diesel" :
    /bensin|petrol|tsi|tfsi|puretech/.test(dr + " " + t) ? "bensin" :
    /hybrid|phev/.test(dr + " " + t) ? "hybrid" : null;
  const girN = /automat|dsg|s-tronic|tiptronic|eat8|automatic/.test((gir || "") + " " + t) ? "automat"
    : /manuell|manual/.test((gir || "") + " " + t) ? "manuell" : null;
  return {
    sok: [merke, modell, motor].filter(Boolean).join(" ").toLowerCase(),
    merke: (merke || "").toLowerCase(),
    aar: aarN,
    alder: aarN ? Math.max(0, naa - aarN) : 8, // ukjent alder → anta 8 (middels)
    km: parseInt(String(km || "").replace(/\D/g, ""), 10) || 0,
    drivstoff: drivstoffN,
    gir: girN,
    turbo: /turbo|tsi|tfsi|tdi|hdi|puretech|ecoboost/.test(t),
  };
}

// ── Hovedfunksjon: bygg validerte poster for en bil ─────────────────────────
// Returnerer { poster:[{omrade,kostNok,sannsynlighet,kilde,hvorfor,lag}], ... }
// AI-en får denne listen og markerer hvilke som er UDEKKET i annonsen.
function byggReferanse(bilData) {
  const b = tolkBil(bilData);
  const poster = [];
  const brukt = new Set();

  // Lag 1: spesifikke treff
  for (const r of SPESIFIKKE) {
    if (r.merker && !r.merker.includes(b.merke)) continue;
    const matcher = !r.match.length
      ? true
      : r.match.some((m) => b.sok.includes(m));
    if (!matcher) continue;
    if (r.aarMin && b.aar && b.aar < r.aarMin) continue;
    if (r.aarMaks && b.aar && b.aar > r.aarMaks) continue;
    if (r.kmMin && b.km < r.kmMin) continue;
    poster.push({ ...postUt(r), lag: 1 });
    brukt.add(r.omrade);
  }

  // Lag 2: generiske regler (kun hvis ikke allerede dekket samme område)
  for (const r of GENERISKE) {
    if (!r.krav(b)) continue;
    if (brukt.has(r.omrade)) continue;
    poster.push({ ...postUt(r), lag: 2 });
    brukt.add(r.omrade);
  }

  // Lag 3: grunnsats – alltid med hvis vi har under 2 poster (sikkerhetsnett)
  if (poster.length < 2) {
    poster.push({ ...postUt(grunnsats(b)), lag: 3 });
  }

  // Sorter synkende etter sannsynlighet, maks 4
  poster.sort((x, y) => y.sannsynlighet - x.sannsynlighet);
  const topp = poster.slice(0, 4);

  return {
    bil: { aar: b.aar, alder: b.alder, km: b.km, drivstoff: b.drivstoff, gir: b.gir },
    poster: topp,
  };
}

function postUt(r) {
  return {
    omrade: r.omrade,
    kostNok: r.kostNok,
    sannsynlighet: r.sannsynlighet,
    kilde: r.kilde,
    hvorfor: r.hvorfor,
  };
}

export { byggReferanse, tolkBil };
