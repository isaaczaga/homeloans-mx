/**
 * /api/confirmar-upload.js
 * Confirma que el cliente subió exitosamente un documento al path que
 * le firmamos en /api/solicitar-upload. Aquí:
 *   1) Verificamos que el archivo existe en Storage.
 *   2) Releemos metadata (size, contentType) para defender contra un
 *      cliente malicioso que haya ignorado nuestro límite front-end
 *      (la signed URL por sí sola NO aplica límite de tamaño).
 *   3) Si supera 20 MB o no es PDF, borramos el archivo y rechazamos.
 *   4) Generamos signed URL de lectura (7 días) para que el CRM lo vea.
 *   5) Agregamos el doc al array `documentos` del lead en Firestore con
 *      la misma estructura que usa whatsapp-webhook.js (para que el bot
 *      y el CRM lo reconozcan sin cambios adicionales).
 *
 * Body:
 *   { token, tipo, storagePath }
 */

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import jwt from "jsonwebtoken";
import { PORTAL_DOC_TYPES } from "./portal-session.js";

const MAX_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TTL_MS = 7 * 24 * 3600 * 1000; // 7 días

let db, bucket;
try {
  const app = getApps().length
    ? getApps()[0]
    : initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
          clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        }),
        storageBucket:
          process.env.FIREBASE_ADMIN_STORAGE_BUCKET ||
          process.env.FIREBASE_STORAGE_BUCKET,
      });
  db = getFirestore(app);
  bucket = getStorage(app).bucket();
} catch (e) {
  console.error("[CONFIRMAR-UPLOAD] Firebase Admin INIT ERROR:", e.message);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  if (!db || !bucket) return res.status(500).json({ error: "Backend no disponible" });
  if (!process.env.PORTAL_JWT_SECRET) {
    return res.status(500).json({ error: "Portal no configurado" });
  }

  // ── 1) Validar JWT del portal ──
  const { token, tipo, storagePath } = req.body || {};
  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "Token faltante" });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.PORTAL_JWT_SECRET, { algorithms: ["HS256"] });
  } catch (e) {
    const reason = e.name === "TokenExpiredError" ? "expirado" : "inválido";
    return res.status(401).json({ error: `Enlace ${reason}. Pide uno nuevo a tu asesor.` });
  }
  const leadId = payload?.leadId;
  if (!leadId) return res.status(401).json({ error: "Token malformado" });

  // ── 2) Validar tipo ──
  const docDef = PORTAL_DOC_TYPES.find((d) => d.key === tipo);
  if (!docDef) return res.status(400).json({ error: `Tipo inválido: ${tipo}` });

  // ── 3) Validar que el storagePath corresponde al leadId del token ──
  // Defensa contra un cliente que firme un path de OTRO lead: el prefix
  // "leads/{leadId}/portal/" es obligatorio. Si no cuadra, rechazamos.
  const expectedPrefix = `leads/${leadId}/portal/`;
  if (!String(storagePath || "").startsWith(expectedPrefix)) {
    console.warn(`[CONFIRMAR-UPLOAD] Path no coincide con lead: ${storagePath} (esperaba ${expectedPrefix}*)`);
    return res.status(400).json({ error: "Ruta de archivo inválida" });
  }

  // ── 4) Leer metadata del archivo en Storage ──
  const file = bucket.file(storagePath);
  let metadata;
  try {
    const [exists] = await file.exists();
    if (!exists) {
      return res.status(404).json({ error: "El archivo no se encontró en Storage. ¿Se completó la subida?" });
    }
    const [meta] = await file.getMetadata();
    metadata = meta;
  } catch (e) {
    console.error("[CONFIRMAR-UPLOAD] Error leyendo metadata:", e.message);
    return res.status(500).json({ error: "No se pudo verificar el archivo" });
  }

  const size = Number(metadata.size);
  const contentType = String(metadata.contentType || "").toLowerCase();

  // ── 5) Defensa: tamaño real y content-type real ──
  if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) {
    // Borrar archivo malicioso / corrupto para no acumular basura.
    try { await file.delete(); } catch {}
    return res.status(400).json({
      error: `Archivo rechazado: tamaño ${(size / 1024 / 1024).toFixed(1)} MB excede el máximo de 20 MB.`,
    });
  }
  if (contentType !== "application/pdf") {
    try { await file.delete(); } catch {}
    return res.status(400).json({
      error: `Archivo rechazado: content-type "${contentType}" no es PDF.`,
    });
  }

  // ── 6) Generar signed URL de lectura (7 días) para el CRM ──
  let downloadUrl;
  try {
    const [url] = await file.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + DOWNLOAD_TTL_MS,
    });
    downloadUrl = url;
  } catch (e) {
    console.error("[CONFIRMAR-UPLOAD] Error firmando URL de lectura:", e.message);
    return res.status(500).json({ error: "Archivo subido pero no se pudo generar preview" });
  }

  // ── 7) Agregar al array `documentos` del lead ──
  // Estructura igual a whatsapp-webhook.js para que el checklist del bot
  // y el CRM lo reconozcan sin cambios. Agregamos `source:"portal"` y
  // `portalTipo:<key>` para distinguirlo.
  const docEntry = {
    source: "portal",
    portalTipo: tipo,
    classification: docDef.classifications[0], // canónico por tipo
    label: docDef.label,
    storagePath,
    url: downloadUrl,
    sizeBytes: size,
    contentType,
    uploadedAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
  };

  try {
    await db
      .collection("solicitudes")
      .doc(leadId)
      .update({
        documentos: FieldValue.arrayUnion(docEntry),
        lastPortalActivityAt: FieldValue.serverTimestamp(),
      });
  } catch (e) {
    console.error("[CONFIRMAR-UPLOAD] Firestore update FAIL:", e.message);
    return res.status(500).json({ error: "Archivo subido pero no se pudo registrar. Contacta a tu asesor." });
  }

  // ── 8) Auditar ──
  try {
    await db
      .collection("solicitudes")
      .doc(leadId)
      .collection("portalAccessLog")
      .add({
        action: "document_uploaded",
        at: new Date(),
        tipo,
        sizeBytes: size,
        storagePath,
        ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "",
        userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
      });
  } catch (e) {
    console.warn("[CONFIRMAR-UPLOAD] No se pudo auditar:", e.message);
  }

  console.log(
    `[CONFIRMAR-UPLOAD] Lead=${leadId} tipo=${tipo} size=${(size / 1024 / 1024).toFixed(2)}MB OK`
  );

  return res.status(200).json({
    success: true,
    tipo,
    downloadUrl,
    uploadedAt: docEntry.uploadedAt,
  });
}
