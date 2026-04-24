/**
 * /api/generar-link-portal.js
 * Firma un JWT corto (48h) que le permite al lead acceder al portal
 * de su expediente sin necesidad de autenticarse con cuenta propia.
 *
 * Flujo:
 *   CRM → (con ID token del agente) → este endpoint → {url, expiresAt}
 *   Agente copia la URL y la manda al lead por WhatsApp (o el CRM la
 *   manda automáticamente).
 *
 * Seguridad:
 *   - Requiere Firebase Auth del agente (Bearer idToken).
 *   - El JWT solo contiene {leadId, iat, exp}. Ningún dato personal.
 *   - El secreto vive en PORTAL_JWT_SECRET (Vercel env var).
 *   - Si el JWT expira, el agente regenera uno nuevo desde el CRM.
 *
 * Body esperado:
 *   { leadId: string }
 */

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import jwt from "jsonwebtoken";

// ── Firebase Admin SDK (singleton) ──────────────────────────
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
        // Incluido porque webhook.js y guardar-expediente.js importan este
        // módulo y, al correrse antes, crean la app compartida que ellos
        // luego reutilizan para Storage. Sin bucket aquí, getStorage().bucket()
        // falla en esos endpoints.
        storageBucket:
          process.env.FIREBASE_ADMIN_STORAGE_BUCKET ||
          process.env.FIREBASE_STORAGE_BUCKET,
      });
  db = getFirestore(app);
} catch (e) {
  console.error("[PORTAL-LINK] Firebase Admin INIT ERROR:", e.message);
}

export const PORTAL_TTL_HOURS = 48;

// Helper reutilizable: firma un token de portal y devuelve {token, url, expiresAt}.
// Se usa desde este handler, desde el webhook y desde guardar-expediente para
// incluir el link en mensajes automáticos al lead.
// Requiere PORTAL_JWT_SECRET en el entorno.
export function signPortalToken(leadId, ttlHours = PORTAL_TTL_HOURS) {
  if (!process.env.PORTAL_JWT_SECRET) {
    throw new Error("PORTAL_JWT_SECRET no está configurado");
  }
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttlHours * 3600;
  const token = jwt.sign(
    { leadId, iat, exp },
    process.env.PORTAL_JWT_SECRET,
    { algorithm: "HS256" }
  );
  const base = (process.env.PUBLIC_SITE_URL || "https://homeloans.mx").replace(/\/$/, "");
  return {
    token,
    url: `${base}/portal.html?t=${token}`,
    expiresAt: new Date(exp * 1000).toISOString(),
    ttlHours,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  if (!db) {
    return res.status(500).json({ error: "Firestore no disponible" });
  }

  if (!process.env.PORTAL_JWT_SECRET) {
    console.error("[PORTAL-LINK] Falta PORTAL_JWT_SECRET en el entorno");
    return res.status(500).json({ error: "Portal no configurado" });
  }

  // ── 1) Verificar ID token del agente (mismo patrón que send-whatsapp) ──
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return res.status(401).json({ error: "Missing Authorization: Bearer <idToken>" });
  }

  let agentEmail, agentUid;
  try {
    const adminAuth = getAuth();
    const decoded = await adminAuth.verifyIdToken(match[1]);
    agentUid = decoded.uid;
    agentEmail = decoded.email || "unknown";
  } catch (e) {
    console.error("[PORTAL-LINK] ID token invalid:", e.message);
    return res.status(401).json({ error: "Token inválido" });
  }

  // ── 2) Validar body ──
  const { leadId } = req.body || {};
  if (!leadId || typeof leadId !== "string" || leadId.length > 40) {
    return res.status(400).json({ error: "leadId inválido" });
  }

  // ── 3) Confirmar que el lead existe ──
  let leadSnap;
  try {
    leadSnap = await db.collection("solicitudes").doc(leadId).get();
  } catch (e) {
    console.error("[PORTAL-LINK] Firestore read FAIL:", e.message);
    return res.status(500).json({ error: "Error al leer el lead" });
  }
  if (!leadSnap.exists) {
    return res.status(404).json({ error: "Lead no encontrado" });
  }

  // ── 4) Firmar token + construir URL ──
  let signed;
  try {
    signed = signPortalToken(leadId);
  } catch (e) {
    console.error("[PORTAL-LINK] Error firmando token:", e.message);
    return res.status(500).json({ error: "Portal no configurado" });
  }

  // ── 5) Auditar generación ──
  try {
    await db
      .collection("solicitudes")
      .doc(leadId)
      .collection("portalAccessLog")
      .add({
        action: "link_generated",
        at: new Date(),
        agentUid,
        agentEmail,
        ttlHours: signed.ttlHours,
      });
  } catch (e) {
    console.warn("[PORTAL-LINK] No se pudo auditar:", e.message);
  }

  console.log(`[PORTAL-LINK] Link generado leadId=${leadId} por agente=${agentEmail} exp=${signed.expiresAt}`);

  return res.status(200).json({
    success: true,
    url: signed.url,
    expiresAt: signed.expiresAt,
    ttlHours: signed.ttlHours,
  });
}
