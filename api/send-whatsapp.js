/**
 * /api/send-whatsapp.js
 * Endpoint para enviar mensajes de WhatsApp desde el CRM.
 * Verifica el ID token de Firebase Auth del agente → envía vía Twilio →
 * guarda el mensaje en whatsapp_sessions.
 *
 * Body esperado:
 *   { leadId?, phone, message, pauseBot? }
 *
 * Por defecto el bot SIGUE RESPONDIENDO en paralelo al agente (coexistencia).
 * Si el agente envía `pauseBot: true`, se pausa el bot durante 24h (modo
 * "tomar control" total del hilo).
 *
 * El webhook inyecta los mensajes del agente al contexto de Claude para
 * evitar respuestas contradictorias o repetitivas.
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

// Canonicaliza un teléfono mexicano a 12 dígitos (52 + 10). Unifica los
// formatos que pueden venir: 10 dígitos (form web), 12 dígitos (ya canónico),
// 13 dígitos con "1" móvil legado (Twilio). Debe coincidir EXACTAMENTE con
// la misma función en whatsapp-webhook.js y con sessionIdFromPhone del CRM.
function canonicalMxPhone(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 10) return "52" + d;
  if (d.length === 13 && d.startsWith("521")) return "52" + d.slice(3);
  return d;
}

function phoneToDocId(phone) {
  const canon = canonicalMxPhone(phone);
  if (canon) return "wa_whatsapp__" + canon;
  return "wa_" + String(phone || "").replace(/\W/g, "_");
}

// Normaliza número a formato WhatsApp de Twilio: "whatsapp:+..."
// NO canonicaliza a 12 dígitos — solo asegura el prefijo "whatsapp:+" y
// agrega "52" a números de 10 dígitos (México). El "1" móvil mexicano
// se respeta si viene, porque el número remitente provisionado en Twilio
// puede estar registrado con o sin él; modificarlo causa
// "Twilio could not find a Channel with the specified From address".
function normalizeWhatsAppNumber(phone) {
  let cleaned = String(phone || "").trim().replace(/^whatsapp:/i, "");
  cleaned = cleaned.replace(/\D/g, "");
  if (cleaned.length === 10) cleaned = "52" + cleaned;
  return "whatsapp:+" + cleaned;
}

// Formatea EXCLUSIVAMENTE el número remitente (TWILIO_WHATSAPP_NUMBER).
// Respeta 1:1 lo configurado en la variable de entorno: solo garantiza el
// prefijo "whatsapp:" y el "+". No canonicaliza ni agrega dígitos.
function formatTwilioSender(raw) {
  const s = String(raw || "").trim();
  if (s.toLowerCase().startsWith("whatsapp:")) {
    const rest = s.slice(9);
    return "whatsapp:" + (rest.startsWith("+") ? rest : "+" + rest.replace(/^\+?/, ""));
  }
  const digits = s.replace(/^\+/, "").replace(/\D/g, "");
  return "whatsapp:+" + digits;
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
  // `message` es el texto que guardamos en Firestore para el hilo del CRM.
  // Si además viene `contentSid`, enviamos el mensaje como plantilla aprobada
  // (Twilio Content API) — necesario fuera de la ventana de 24h. En ese caso
  // `contentVariables` es un objeto {"1":"Nombre","2":"https://..."} que Twilio
  // sustituye en la plantilla. El `message` debe contener el texto YA
  // renderizado para que el log refleje lo que vio el cliente.
  const { leadId, phone, message, pauseBot, contentSid, contentVariables } = req.body || {};
  // pauseBot es OPCIONAL. Por defecto el bot sigue respondiendo (coexistencia).
  // Solo se pausa si el agente marca explícitamente la casilla "Tomar control".
  const shouldPauseBot = pauseBot === true;
  if (!phone || !message || !String(message).trim()) {
    return res.status(400).json({ error: "Se requiere phone y message" });
  }
  if (String(message).length > 1600) {
    return res.status(400).json({ error: "Mensaje excede 1600 caracteres" });
  }

  // Validar plantilla si viene
  let contentVariablesStr = null;
  if (contentSid) {
    if (typeof contentSid !== "string" || !contentSid.startsWith("HX")) {
      return res.status(400).json({ error: "contentSid inválido (debe empezar con HX)" });
    }
    if (contentVariables && typeof contentVariables === "object") {
      try {
        contentVariablesStr = JSON.stringify(contentVariables);
      } catch {
        return res.status(400).json({ error: "contentVariables no serializable" });
      }
    }
  }

  const toNumber = normalizeWhatsAppNumber(phone);
  // IMPORTANTE: el sender NUNCA se canonicaliza. Twilio requiere que el "from"
  // coincida 1:1 con el canal provisionado (puede tener "1" móvil o no).
  const fromNumber = formatTwilioSender(process.env.TWILIO_WHATSAPP_NUMBER);

  // ── 3) Enviar vía Twilio ──
  let twilioSid;
  try {
    const payload = contentSid
      ? {
          from: fromNumber,
          to: toNumber,
          contentSid,
          ...(contentVariablesStr ? { contentVariables: contentVariablesStr } : {}),
        }
      : {
          from: fromNumber,
          to: toNumber,
          body: String(message).trim(),
        };
    const msg = await twilioClient.messages.create(payload);
    twilioSid = msg.sid;
    console.log(
      `[SEND] Mensaje enviado a ${toNumber} por ${agentEmail} — SID: ${twilioSid}${contentSid ? ` (plantilla ${contentSid})` : ""}`
    );
  } catch (e) {
    console.error("[SEND] Twilio FAIL:", e.code, e.message);
    const msg = e.code === 63016
      ? "Fuera de la ventana de 24h: debes usar una plantilla pre-aprobada."
      : `Twilio error: ${e.message}`;
    return res.status(502).json({ error: msg, twilioCode: e.code });
  }

  // ── 4) Persistir en Firestore ──
  // Si shouldPauseBot=true, pausamos el bot 24h (modo "tomar control").
  // Si shouldPauseBot=false (default), el bot sigue respondiendo en paralelo.
  const pausedUntil = shouldPauseBot ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null;
  const sessionRef = db.collection("whatsapp_sessions").doc(phoneToDocId(toNumber));
  const agentMsg = {
    role: "agent",
    content: String(message).trim(),
    at: new Date().toISOString(),
    agentEmail,
    twilioSid,
  };

  try {
    const sessionUpdate = {
      messages: FieldValue.arrayUnion(agentMsg),
      lastActivity: FieldValue.serverTimestamp(),
      lastAgent: agentEmail,
      lastAgentAt: FieldValue.serverTimestamp(),
      phone: toNumber,
    };
    if (pausedUntil) sessionUpdate.agentPausedUntil = pausedUntil;
    await sessionRef.set(sessionUpdate, { merge: true });
  } catch (e) {
    console.error("[SEND] Firestore session write FAIL:", e.code, e.message);
    // El mensaje ya se envió, no rompemos — solo avisamos
  }

  if (leadId) {
    try {
      const leadUpdate = {
        lastOutboundAt: FieldValue.serverTimestamp(),
        lastOutboundBy: agentEmail,
      };
      if (pausedUntil) leadUpdate.agentPausedUntil = pausedUntil;
      await db.collection("solicitudes").doc(leadId).set(leadUpdate, { merge: true });
    } catch (e) {
      console.error("[SEND] Firestore lead update FAIL:", e.code, e.message);
    }
  }

  return res.status(200).json({
    ok: true,
    twilioSid,
    pausedUntil: pausedUntil ? pausedUntil.toISOString() : null,
    botPaused: !!pausedUntil,
  });
}
