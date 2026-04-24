/**
 * /api/admin-set-cors.js
 * Endpoint administrativo (one-shot) para configurar CORS en el bucket de
 * Firebase Storage. Sin esto, el PUT directo del portal al signed URL es
 * bloqueado por el navegador (preflight sin Access-Control-Allow-Origin).
 *
 * Seguridad:
 *   - Requiere Firebase Auth del agente (Bearer idToken) igual que los
 *     demás endpoints del CRM.
 *   - No recibe input — la configuración CORS está hardcodeada abajo.
 *   - Idempotente: aplica la misma configuración cada vez.
 *
 * Uso:
 *   curl -X POST https://homeloans.mx/api/admin-set-cors \
 *     -H "Authorization: Bearer <idToken>"
 *
 * Después de que CORS quede aplicado y verificado, este archivo puede
 * borrarse — la config queda en el bucket.
 */

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import { getAuth } from "firebase-admin/auth";

let app;
try {
  app = getApps().length
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
} catch (e) {
  console.error("[ADMIN-CORS] Firebase Admin INIT ERROR:", e.message);
}

const corsConfig = [
  {
    origin: [
      "https://homeloans.mx",
      "https://www.homeloans.mx",
      "https://homeloans-mx.vercel.app",
    ],
    method: ["GET", "PUT", "POST", "HEAD", "OPTIONS"],
    responseHeader: [
      "Content-Type",
      "x-goog-resumable",
      "x-goog-meta-*",
      "Authorization",
    ],
    maxAgeSeconds: 3600,
  },
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  if (!app) return res.status(500).json({ error: "Firebase Admin no disponible" });

  // Auth: requiere agente autenticado
  const authHeader = req.headers.authorization || "";
  const m = authHeader.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: "Missing Authorization" });

  try {
    const decoded = await getAuth().verifyIdToken(m[1]);
    console.log("[ADMIN-CORS] Agent:", decoded.email);
  } catch (e) {
    return res.status(401).json({ error: "Token inválido" });
  }

  try {
    const bucket = getStorage(app).bucket();
    await bucket.setCorsConfiguration(corsConfig);
    const [metadata] = await bucket.getMetadata();
    console.log("[ADMIN-CORS] CORS actualizado en", bucket.name);
    return res.status(200).json({
      ok: true,
      bucket: bucket.name,
      cors: metadata.cors || null,
    });
  } catch (e) {
    console.error("[ADMIN-CORS] Error:", e.message);
    return res.status(500).json({ error: e.message });
  }
}
