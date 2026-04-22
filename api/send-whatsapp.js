/**
 * /api/send-whatsapp.js
 * Endpoint para enviar mensajes de WhatsApp desde el CRM.
 * Verifica el ID token de Firebase Auth del agente → envía vía Twilio →
 * guarda el mensaje en whatsapp_sessions + pausa el bot 24h.
 */

import twilio from "twilio";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

// ── Firebase Admin SDK (singleton, mismo patrón que el webhook) ──
let db;
try {
  const app = getApps().length
    ? getApps()[0]
    : initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
          clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        }),
      });
  db = getFirestore(app);
  console.log("[SEND] Firebase Admin OK — project:", process.env.FIREBASE_ADMIN_PROJECT_ID);
} catch (e) {
  console.error("[SEND] Firebase Admin INIT ERROR:", e.message, e.stack);
}

// ── Twilio client ───────────────────────────────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── Utilidades ──────────────────────────────────────────────
function phoneToDocId(phone) {
  return "wa_" + phone.replace(/\W/g, "_");
}

// Normaliza número a formato WhatsApp de Twilio: "whatsapp:+52..."
function normalizeWhatsAppNumber(phone) {
  const cleaned = String(phone).trim().replace(/^whatsapp:/i, "");
  const withPlus = cleaned.startsWith("+") ? cleaned : "+" + cleaned.replace(/^\+?/, "");
  return "whatsapp:" + withPlus;
}

// ── Handler ─────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  // Diagnóstico temprano: qué env vars faltan
  const missing = [];
  if (!process.env.FIREBASE_ADMIN_PROJECT_ID) missing.push("FIREBASE_ADMIN_PROJECT_ID");
  if (!process.env.FIREBASE_ADMIN_CLIENT_EMAIL) missing.push("FIREBASE_ADMIN_CLIENT_EMAIL");
  if (!process.env.FIREBASE_ADMIN_PRIVATE_KEY) missing.push("FIREBASE_ADMIN_PRIVATE_KEY");
  if (!process.env.TWILIO_ACCOUNT_SID) missing.push("TWILIO_ACCOUNT_SID");
  if (!process.env.TWILIO_AUTH_TOKEN) missing.push("TWILIO_AUTH_TOKEN");
  if (!process.env.TWILIO_WHATSAPP_NUMBER) missing.push("TWILIO_WHATSAPP_NUMBER");

  if (missing.length) {
    console.error("[SEND] ENV vars faltantes:", missing.join(", "));
    return res.status(500).json({
      error: `Faltan variables de entorno en Vercel: ${missing.join(", ")}`,
    });
  }

  if (!db) {
    console.error("[SEND] Firestore no disponible — revisa logs de INIT");
    return res.status(500).json({
      error: "Firestore no inicializado. Revisa los logs de Vercel (buscar '[SEND] Firebase Admin INIT ERROR').",
    });
  }

  // ── 1) Verificar ID token del agente ──
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return res.status(401).json({ error: "Missing Authorization: Bearer <idToken>" });
  }

  let agentEmail, agentUid;
  try {
    // Obtenemos adminAuth lazy — si firebase-admin/auth falla, lo aislamos aquí.
    const adminAuth = getAuth();
    const decoded = await adminAuth.verifyIdToken(match[1]);
    agentUid = decoded.uid;
    agentEmail = decoded.email || "unknown";
  } catch (e) {
    console.error("[SEND] Auth FAIL:", e.code, e.message);
    return res.status(401).json({
      error: `Token inválido o problema de Auth: ${e.message}`,
    });
  }

  // ── 2) Validar body ──
  const { leadId, phone, message } = req.body || {};
  if (!phone || !message || !String(message).trim()) {
    return res.status(400).json({ error: "Se requiere phone y message" });
  }
  if (String(message).length > 1600) {
    return res.status(400).json({ error: "Mensaje excede 1600 caracteres" });
  }

  const toNumber = normalizeWhatsAppNumber(phone);
  const fromNumber = normalizeWhatsAppNumber(process.env.TWILIO_WHATSAPP_NUMBER);

  // ── 3) Enviar vía Twilio ──
  let twilioSid;
  try {
    const msg = await twilioClient.messages.create({
      from: fromNumber,
      to: toNumber,
      body: String(message).trim(),
    });
    twilioSid = msg.sid;
    console.log(`[SEND] Mensaje enviado a ${toNumber} por ${agentEmail} — SID: ${twilioSid}`);
  } catch (e) {
    console.error("[SEND] Twilio FAIL:", e.code, e.message);
    const msg = e.code === 63016
      ? "Fuera de la ventana de 24h: debes usar una plantilla pre-aprobada."
      : `Twilio error: ${e.message}`;
    return res.status(502).json({ error: msg, twilioCode: e.code });
  }

  // ── 4) Persistir en Firestore ──
  const pausedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const sessionRef = db.collection("whatsapp_sessions").doc(phoneToDocId(toNumber));
  const agentMsg = {
    role: "agent",
    content: String(message).trim(),
    at: new Date().toISOString(),
    agentEmail,
    twilioSid,
  };

  try {
    await sessionRef.set(
      {
        messages: FieldValue.arrayUnion(agentMsg),
        lastActivity: FieldValue.serverTimestamp(),
        agentPausedUntil: pausedUntil,
        lastAgent: agentEmail,
        phone: toNumber,
      },
      { merge: true }
    );
  } catch (e) {
    console.error("[SEND] Firestore session write FAIL:", e.code, e.message);
    // El mensaje ya se envió, no rompemos — solo avisamos
  }

  if (leadId) {
    try {
      await db.collection("solicitudes").doc(leadId).set(
        {
          lastOutboundAt: FieldValue.serverTimestamp(),
          lastOutboundBy: agentEmail,
          agentPausedUntil: pausedUntil,
        },
        { merge: true }
      );
    } catch (e) {
      console.error("[SEND] Firestore lead update FAIL:", e.code, e.message);
    }
  }

  return res.status(200).json({
    ok: true,
    twilioSid,
    pausedUntil: pausedUntil.toISOString(),
  });
}
