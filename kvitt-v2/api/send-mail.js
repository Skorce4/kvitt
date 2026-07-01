// api/send-mail.js
// Sender den ferdige analysen til brukerens e-post via Resend.
// Kalles av frontend når bruker trykker "Send" i e-postboksen ETTER analysen.
// Feiler stille hvis Resend ikke er satt opp – da svarer den pent uten å kræsje.
//
// Krever miljøvariabelen RESEND_API_KEY + verifisert kvittn.no-domene i Resend.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Bruk POST." });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return res.status(200).json({ ok: false, grunn: "Mail ikke konfigurert" });
  }

  try {
    const { epost, analyse } = req.body || {};
    if (!epost || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(epost)) {
      return res.status(400).json({ error: "Ugyldig e-postadresse." });
    }
    if (!analyse || !analyse.improved) {
      return res.status(400).json({ error: "Mangler analyse." });
    }

    const html = byggHtml(analyse);

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: "Kvittn <ingen-svar@kvittn.no>",
        to: [epost],
        subject: "Din annonseanalyse fra Kvittn",
        html,
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      return res.status(502).json({ error: "Kunne ikke sende e-post.", detail });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "Uventet feil ved sending." });
  }
}

function byggHtml(a) {
  const improved = String(a.improved || "").replace(/\n/g, "<br>");
  const legal = String(a.legal || "").replace(/\n/g, "<br>");
  const rk = a.reklamasjon || {};
  const kr =
    rk.eksponering_nok != null
      ? Number(rk.eksponering_nok).toLocaleString("no-NO") + " kr"
      : "Ingen vesentlig eksponering";

  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;color:#101a2c">
    <h2 style="color:#101a2c;margin-bottom:4px">Din annonseanalyse</h2>
    <p style="color:#46546b;margin-top:0">Trygghet: <b>${escapeHtml(String(a.score ?? ""))}/100</b> – ${escapeHtml(a.label || "")}</p>

    <div style="margin:18px 0;padding:16px;border-left:3px solid #e63946;background:#fff5f5;border-radius:8px">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#8893a4">Reklamasjonsrisiko</div>
      <div style="font-size:15px;margin-top:4px"><b>${escapeHtml(rk.utfall || "Ukjent")}</b> · ${escapeHtml(kr)}</div>
      <div style="font-size:13px;color:#46546b;margin-top:6px">${escapeHtml(rk.begrunnelse || "")}</div>
    </div>

    <h3 style="color:#101a2c">Forbedret annonsetekst</h3>
    <div style="background:#f7f6f2;border-radius:10px;padding:18px;line-height:1.6;font-size:14px">${improved}</div>

    <h3 style="color:#101a2c;margin-top:20px">Forbehold å ha med</h3>
    <div style="background:#f7f6f2;border-radius:10px;padding:18px;line-height:1.6;font-size:14px">${legal}</div>

    <p style="color:#8893a4;font-size:12px;margin-top:24px">Kvittn gir veiledende informasjon, ikke juridisk rådgivning.</p>
  </div>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
