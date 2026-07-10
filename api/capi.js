/**
 * /api/capi.js — HomeLoans.mx Conversions API (Meta CAPI)
 *
 * Vercel Serverless Function que recibe eventos del pixel del navegador
 * y los reenvía a Meta desde el servidor, recuperando conversiones
 * perdidas por iOS 14+, bloqueadores de ads y Safari ITP.
 *
 * Endpoint: POST https://www.homeloans.mx/api/capi
 *
 * Variables de entorno requeridas en Vercel Dashboard:
 *   FACEBOOK_ACCESS_TOKEN  — System User token de Meta Business Suite
 *   FACEBOOK_PIXEL_ID      — 2219149935562688
 */

const PIXEL_ID    = process.env.FACEBOOK_PIXEL_ID    || "2219149935562688";
const ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN;
const META_API    = `https://graph.facebook.com/v19.0/${PIXEL_ID}/events`;

export default async function handler(req, res) {

  // ── Solo POST ──────────────────────────────────────────────
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ── Validar token configurado ──────────────────────────────
  if (!ACCESS_TOKEN) {
    console.error("[CAPI] FACEBOOK_ACCESS_TOKEN no configurado en Vercel");
    return res.status(500).json({ error: "Server configuration error" });
  }

  // ── Parsear body ───────────────────────────────────────────
  const body = req.body;
  if (!body || !body.event_name || !body.event_time) {
    return res.status(400).json({ error: "Missing required: event_name, event_time" });
  }

  // ── IP real del usuario ────────────────────────────────────
  const clientIp =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "0.0.0.0";

  const clientUA = req.headers["user-agent"] || "";

  // ── Construir user_data (los hashes vienen del cliente) ────
  const userData = {
    ...(body.user_data || {}),
    client_ip_address: clientIp,
    client_user_agent: clientUA,
  };
  // Limpiar nulos
  Object.keys(userData).forEach((k) => { if (!userData[k]) delete userData[k]; });

  // ── Construir evento ───────────────────────────────────────
  const metaEvent = {
    event_name:       body.event_name,
    event_time:       body.event_time,
    event_id:         body.event_id || `hl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    event_source_url: body.event_source_url || "https://www.homeloans.mx",
    action_source:    body.action_source || "website",
    user_data:        userData,
    custom_data:      body.custom_data || {},
  };

  // ── Enviar a Meta CAPI ─────────────────────────────────────
  try {
    const metaRes = await fetch(`${META_API}?access_token=${ACCESS_TOKEN}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ data: [metaEvent] }),
    });

    const metaData = await metaRes.json();

    console.log(
      `[CAPI] ${body.event_name} | status:${metaRes.status}` +
      ` | received:${metaData.events_received ?? 0}` +
      ` | ip:${clientIp.substring(0, 10)}...`
    );

    return res.status(metaRes.ok ? 200 : metaRes.status).json({
      success:         metaRes.ok,
      events_received: metaData.events_received ?? 0,
      event_name:      body.event_name,
      fbtrace_id:      metaData.fbtrace_id ?? null,
    });

  } catch (err) {
    console.error("[CAPI] Error calling Meta API:", err.message);
    return res.status(502).json({ error: "Failed to reach Meta API" });
  }
}
