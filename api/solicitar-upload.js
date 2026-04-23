/**
 * /api/solicitar-upload.js
 * Genera una signed URL de Firebase Storage para que el lead suba UN
 * documento directamente desde el navegador, sin pasar por Vercel (que
 * tiene límite de ~4.5 MB de body).
 *
 * Esquema:
 *   Portal → /api/solicitar-upload {token, tipo, fileSize, contentType}
 *     ↓
 *   Server valida JWT + tipo + tamaño (≤20 MB) + content-type (application/pdf)
 *     ↓
 *   Server firma URL de escritura para:
 *       leads/{leadId}/portal/{tipo}_{timestamp}.pdf
 *     con expiración de 10 min y content-type forzado a application/pdf.
 *     ↓
 *   Portal hace PUT directo a Storage con el archivo.
 *     ↓
 *   Portal llama /api/confirmar-upload para cerrar el ciclo.
 *
 * Body:
 *   { token: string, tipo: string, fileSize: number, contentType: string }
 *
 * Response:
 *   { success, uploadUrl, storagePath, expiresAt }
 */

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import jwt from "jsonwebtoken";
import { PORTAL_DOC_TYPES } from "./portal-session.js";

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB
const UPLOAD_TTL_SECONDS = 10 * 60; // 10 min

let bucket;
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
          process.env.FIREBASE_STORAGE_BUCKET ||
          `${process.env.FIREBASE_ADMIN_PROJECT_ID}.appspot.com`,
      });
  bucket = getStorage(app).bucket();
} catch (e) {
  console.error("[SOLICITAR-UPLOAD] Firebase Admin INIT ERROR:", e.message);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  if (!bucket) return res.status(500).json({ error: "Storage no disponible" });
  if (!process.env.PORTAL_JWT_SECRET) {
    return res.status(500).json({ error: "Portal no configurado" });
  }

  // ── 1) Validar JWT del portal ──
  const { token, tipo, fileSize, contentType } = req.body || {};
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
  if (!leadId || typeof leadId !== "string") {
    return res.status(401).json({ error: "Token malformado" });
  }

  // ── 2) Validar tipo de documento contra checklist oficial ──
  const docDef = PORTAL_DOC_TYPES.find((d) => d.key === tipo);
  if (!docDef) {
    return res.status(400).json({ error: `Tipo de documento no válido: ${tipo}` });
  }

  // ── 3) Validar tamaño y content-type ──
  const size = Number(fileSize);
  if (!Number.isFinite(size) || size <= 0) {
    return res.status(400).json({ error: "fileSize inválido" });
  }
  if (size > MAX_BYTES) {
    return res.status(400).json({
      error: `El archivo pesa ${(size / 1024 / 1024).toFixed(1)} MB. El máximo permitido es 20 MB.`,
    });
  }

  const ct = String(contentType || "").toLowerCase();
  if (ct !== "application/pdf") {
    return res.status(400).json({
      error: "Solo se aceptan archivos PDF (application/pdf).",
    });
  }

  // ── 4) Construir path único e irrepetible ──
  // Incluimos timestamp para que el lead pueda re-subir un documento sin
  // sobrescribir el anterior (auditoría). El "último subido" por tipo se
  // resuelve en confirmar-upload actualizando Firestore.
  const timestamp = Date.now();
  const storagePath = `leads/${leadId}/portal/${tipo}_${timestamp}.pdf`;

  // ── 5) Firmar URL de escritura (v4, con content-type lock) ──
  const expiresAtMs = Date.now() + UPLOAD_TTL_SECONDS * 1000;
  let uploadUrl;
  try {
    const file = bucket.file(storagePath);
    const [url] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: expiresAtMs,
      contentType: "application/pdf",
    });
    uploadUrl = url;
  } catch (e) {
    console.error("[SOLICITAR-UPLOAD] Error firmando URL:", e.message);
    return res.status(500).json({ error: "No se pudo generar la URL de subida" });
  }

  console.log(
    `[SOLICITAR-UPLOAD] Lead=${leadId} tipo=${tipo} size=${(size / 1024 / 1024).toFixed(2)}MB path=${storagePath}`
  );

  return res.status(200).json({
    success: true,
    uploadUrl,
    storagePath,
    expiresAt: new Date(expiresAtMs).toISOString(),
    // El cliente DEBE enviar el archivo con este header o la firma falla:
    requiredHeaders: { "Content-Type": "application/pdf" },
  });
}
