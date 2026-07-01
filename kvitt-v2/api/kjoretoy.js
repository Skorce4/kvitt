// api/kjoretoy.js
// Slår opp tekniske kjøretøydata fra Statens vegvesen via registreringsnummer.
// Enkeltoppslag-API (uten eierinfo) – åpent for privatpersoner med API-nøkkel.
// Krever miljøvariabelen VEGVESEN_API_KEY. Uten den svarer funksjonen pent
// at oppslag ikke er tilgjengelig, så frontend ikke kræsjer.
//
// Nøkkel søkes om gratis på:
// https://autosys-kjoretoy-api.atlas.vegvesen.no/

const ENDPOINT =
  "https://www.vegvesen.no/ws/no/vegvesen/kjoretoy/felles/datautlevering/enkeltoppslag/kjoretoydata";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Bruk POST." });

  const apiKey = process.env.VEGVESEN_API_KEY;
  if (!apiKey) {
    // Ikke satt opp ennå – svar pent så frontend viser riktig
    return res.status(200).json({ ok: false, grunn: "Kjøretøyoppslag ikke aktivert" });
  }

  try {
    const { regnr } = req.body || {};
    if (!regnr) return res.status(400).json({ error: "Mangler registreringsnummer." });

    // Rens reg.nr: fjern mellomrom, store bokstaver, kun 2-7 tegn
    const kjennemerke = String(regnr).replace(/\s+/g, "").toUpperCase();
    if (!/^[A-Z0-9]{2,7}$/.test(kjennemerke)) {
      return res.status(400).json({ error: "Ugyldig registreringsnummer." });
    }

    const r = await fetch(ENDPOINT + "?kjennemerke=" + encodeURIComponent(kjennemerke), {
      method: "GET",
      headers: { "SVV-Authorization": "Apikey " + apiKey, Accept: "application/json" },
    });

    if (!r.ok) {
      return res.status(502).json({ ok: false, grunn: "Fant ikke kjøretøyet", status: r.status });
    }

    const data = await r.json();
    const kort = trekkUtNyttig(data);
    return res.status(200).json({ ok: true, data: kort });
  } catch (e) {
    console.error("Vegvesen-oppslag feilet:", e);
    return res.status(500).json({ ok: false, grunn: "Oppslag feilet." });
  }
}

// Plukker ut de mest nyttige feltene fra vegvesen-responsen for annonseanalyse.
// Strukturen er dyp; vi henter defensivt og hopper over det som mangler.
function trekkUtNyttig(data) {
  const kt = (data && data.kjoretoydataListe && data.kjoretoydataListe[0]) || data || {};
  const tekn = kt.godkjenning?.tekniskGodkjenning?.tekniskeData || {};
  const reg = kt.registrering || {};
  const forstegang = kt.forstegangsregistrering || {};
  const periodisk = kt.periodiskKjoretoyKontroll || {};

  const ut = {
    merke: firstOf(tekn.generelt?.merke, "merke"),
    modell: tekn.generelt?.handelsbetegnelse?.[0] || null,
    farge: tekn.karosseriOgLasteplan?.rFarge?.[0]?.kodeNavn || null,
    forstegangRegistrertNorge: forstegang?.registrertForstegangNorgeDato || null,
    drivstoff: tekn.miljodata?.miljoOgdrivstoffgruppe?.[0]?.drivstoffKodeMiljodata?.kodeNavn || null,
    effektKw: tekn.motorOgDrivverk?.motor?.[0]?.drivstoff?.[0]?.maksNettoEffekt || null,
    egenvekt: tekn.vekter?.egenvekt || null,
    // EU-kontroll: nettopp det Kjerra bruker
    sisteEuKontroll: periodisk?.sistGodkjent || null,
    nesteEuKontroll: periodisk?.kontrollfrist || null,
  };
  return ut;
}

function firstOf(arr) {
  if (Array.isArray(arr) && arr.length) {
    return arr[0]?.merke || arr[0]?.kodeNavn || arr[0] || null;
  }
  return arr || null;
}
