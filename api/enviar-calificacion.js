/**
 * /api/enviar-calificacion.js
 * Recibe la pre-calificación del form público de homeloans.mx y crea
 * un lead en Firestore.
 *
 * IMPORTANTE: Usa el Admin SDK para bypasear las reglas de Firestore
 * (que tienen `allow create: if false` en la colección `solicitudes`).
 * Si se usara el Client SDK, todas las solicitudes fallarían con
 * "Error al escribir en la base de datos".
 */

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

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
      });
  db = getFirestore(app);
  console.log("[FORM] Firebase Admin OK — project:", process.env.FIREBASE_ADMIN_PROJECT_ID);
} catch (e) {
  console.error("[FORM] Firebase Admin INIT ERROR:", e.message);
}

// ── Validación simple ───────────────────────────────────────
function toInt(v) {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method Not Allowed" });
  }

  if (!db) {
    console.error("[FORM] Firestore no disponible — revisa FIREBASE_ADMIN_* en Vercel");
    return res.status(500).json({
      success: false,
      message: "Error de configuración del servidor. Contáctanos directamente por WhatsApp.",
    });
  }

  const data = req.body || {};

  // Validaciones básicas
  if (!data.fullName || !data.phone) {
    return res.status(400).json({
      success: false,
      message: "Faltan datos obligatorios (nombre o teléfono).",
    });
  }

  const payload = {
    fullName: String(data.fullName).trim(),
    email: String(data.email || "").trim(),
    phone: String(data.phone).replace(/\D/g, ""),
    loanPurpose: data.loanPurpose || "compra",
    propertyValue: toInt(data.propertyValue),
    monthlyIncome: toInt(data.monthlyIncome),
    creditScore: data.creditScore || "",
    fecha: FieldValue.serverTimestamp(),
    estado: "Recibida",
    source: "web_form",
  };

  if (payload.loanPurpose === "compra") {
    payload.downPayment = toInt(data.downPayment);
  } else if (payload.loanPurpose === "refinanciamiento") {
    payload.currentBalance = toInt(data.currentBalance);
    payload.currentInterestRate = String(data.currentInterestRate || "");
    payload.currentBank = String(data.currentBank || "");
  }

  try {
    const leadsRef = db.collection("solicitudes");
    const existingSnap = await leadsRef.where("phone", "==", payload.phone).limit(1).get();
    let docId;

    if (!existingSnap.empty) {
      docId = existingSnap.docs[0].id;
      delete payload.fecha; // no sobreescribir la fecha original
      delete payload.estado; // no reiniciar estado si ya avanzó
      payload.ultimaActualizacionWeb = FieldValue.serverTimestamp();
      await leadsRef.doc(docId).set(payload, { merge: true });
      console.log(`[FORM] Lead existente actualizado: ${docId} — ${payload.fullName} (${payload.phone})`);
    } else {
      const docRef = await leadsRef.add(payload);
      docId = docRef.id;
      console.log(`[FORM] Lead creado: ${docId} — ${payload.fullName} (${payload.phone})`);
    }

    return res.status(200).json({
      success: true,
      message: "Solicitud guardada.",
      docId: docId,
    });
  } catch (e) {
    console.error("[FORM] Firestore write FAIL:", e.code, e.message);
    return res.status(500).json({
      success: false,
      message: "Error al guardar su solicitud. Intente de nuevo o contáctenos por WhatsApp.",
    });
  }
}
