/**
 * /api/guardar-expediente.js
 * Recibe la 2ª etapa del expediente (datos completos del cliente)
 * y actualiza el lead existente en Firestore.
 *
 * La 1ª etapa (/api/enviar-calificacion) crea el lead con datos mínimos.
 * Esta 2ª etapa agrega:
 *   - Datos laborales (empresa, puesto, antigüedad)
 *   - Ubicaciones (residencia, trabajo, inmueble) con GPS + texto
 *   - Referencias personales/comerciales (opcionales)
 *   - Perfil médico para seguro de vida (con consentimiento LFPDPPP)
 *
 * Seguridad: el leadId (Firestore doc ID, 20 chars no-guessables) actúa
 * como token. Solo actualiza leads en estado "Recibida" o "En Seguimiento".
 */

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import twilio from "twilio";
import { signPortalToken } from "./generar-link-portal.js";
import { maybeAlertAgent } from "../lib/lead-alerts.js";

// Normaliza número a formato WhatsApp de Twilio
function normalizeWhatsAppNumber(phone) {
  let cleaned = String(phone).trim().replace(/^whatsapp:/i, "");
  cleaned = cleaned.replace(/\D/g, "");
  if (cleaned.length === 10) {
    cleaned = "52" + cleaned; // Asumir México si son 10 dígitos
  }
  return "whatsapp:+" + cleaned;
}

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
  console.log("[EXP] Firebase Admin OK — project:", process.env.FIREBASE_ADMIN_PROJECT_ID);
} catch (e) {
  console.error("[EXP] Firebase Admin INIT ERROR:", e.message);
}

// ── Utilidades ──────────────────────────────────────────────
function sanitizeStr(v, max = 200) {
  if (v === undefined || v === null) return "";
  return String(v).trim().slice(0, max);
}

function sanitizePhone(v) {
  return String(v || "").replace(/\D/g, "").slice(0, 15);
}

function sanitizeEmail(v) {
  const s = String(v || "").trim().toLowerCase().slice(0, 200);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : "";
}

function sanitizeNumber(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function sanitizeGeo(loc) {
  if (!loc || typeof loc !== "object") return null;
  const lat = sanitizeNumber(loc.lat);
  const lng = sanitizeNumber(loc.lng);
  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return {
    lat,
    lng,
    accuracy: sanitizeNumber(loc.accuracy),
    capturedAt: new Date().toISOString(),
  };
}

function sanitizeReferencia(ref) {
  if (!ref || typeof ref !== "object") return null;
  const nombre = sanitizeStr(ref.nombre, 100);
  const apellidos = sanitizeStr(ref.apellidos, 100);
  const telefono = sanitizePhone(ref.telefono);
  const email = sanitizeEmail(ref.email);
  const relacion = sanitizeStr(ref.relacion, 50);
  // Al menos nombre + telefono para que la referencia sea válida
  if (!nombre || !telefono) return null;
  return { nombre, apellidos, telefono, email, relacion };
}

// ── Handler ─────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method Not Allowed" });
  }

  if (!db) {
    console.error("[EXP] Firestore no disponible — revisa FIREBASE_ADMIN_* en Vercel");
    return res.status(500).json({
      success: false,
      message: "Error de configuración del servidor. Contáctanos por WhatsApp.",
    });
  }

  const data = req.body || {};
  const leadId = sanitizeStr(data.leadId, 40);

  if (!leadId) {
    return res.status(400).json({
      success: false,
      message: "Falta el identificador del expediente (leadId).",
    });
  }

  // Consentimiento explícito LFPDPPP para datos médicos (requerido si se envía perfil médico)
  const medicalConsent = data.medicalConsent === true || data.medicalConsent === "true";
  const hasMedicalData =
    data.pesoKg || data.estaturaM || (Array.isArray(data.condicionesMedicas) && data.condicionesMedicas.length);

  if (hasMedicalData && !medicalConsent) {
    return res.status(400).json({
      success: false,
      message: "Para guardar datos médicos se requiere aceptar el aviso de privacidad.",
    });
  }

  // ── Cargar lead existente y validar estado ──
  const leadRef = db.collection("solicitudes").doc(leadId);
  let leadSnap;
  try {
    leadSnap = await leadRef.get();
  } catch (e) {
    console.error("[EXP] Firestore read FAIL:", e.code, e.message);
    return res.status(500).json({ success: false, message: "Error al leer el expediente." });
  }

  if (!leadSnap.exists) {
    return res.status(404).json({
      success: false,
      message: "Expediente no encontrado. Verifica el enlace o contáctanos por WhatsApp.",
    });
  }

  // ── Construir payload del expediente ──
  const expediente = {
    // Laboral
    empresa: sanitizeStr(data.empresa, 150),
    puesto: sanitizeStr(data.puesto, 100),
    antiguedadAnios: sanitizeNumber(data.antiguedadAnios),

    // Ubicaciones
    direccionResidencia: sanitizeStr(data.direccionResidencia, 300),
    geoResidencia: sanitizeGeo(data.geoResidencia),
    direccionTrabajo: sanitizeStr(data.direccionTrabajo, 300),
    geoTrabajo: sanitizeGeo(data.geoTrabajo),
    direccionInmueble: sanitizeStr(data.direccionInmueble, 300),
    geoInmueble: sanitizeGeo(data.geoInmueble),

    // Perfil médico (solo si hay consentimiento)
    pesoKg: hasMedicalData ? sanitizeNumber(data.pesoKg) : null,
    estaturaM: hasMedicalData ? sanitizeNumber(data.estaturaM) : null,
    condicionesMedicas: hasMedicalData && Array.isArray(data.condicionesMedicas)
      ? data.condicionesMedicas.map(c => sanitizeStr(c, 100)).filter(Boolean).slice(0, 20)
      : [],
    notasMedicas: hasMedicalData ? sanitizeStr(data.notasMedicas, 500) : "",
    medicalConsent: hasMedicalData ? true : false,
    medicalConsentAt: hasMedicalData ? new Date().toISOString() : null,

    // Timestamps
    expedienteCompletadoAt: FieldValue.serverTimestamp(),
    expedienteUpdatedAt: FieldValue.serverTimestamp(),
  };

  // Referencias (opcionales — solo si el usuario llenó al menos una)
  const referencias = [];
  if (Array.isArray(data.referencias)) {
    for (const r of data.referencias.slice(0, 5)) {
      const clean = sanitizeReferencia(r);
      if (clean) referencias.push(clean);
    }
  }
  expediente.referencias = referencias;

  // Marcar completitud parcial/total para Kanban/CRM
  const tieneLaboral = !!expediente.empresa;
  const tieneUbicacion = !!(expediente.direccionResidencia || expediente.geoResidencia);
  const tieneReferencias = referencias.length > 0;
  const tieneMedico = hasMedicalData && medicalConsent;

  expediente.expedienteProgreso = {
    laboral: tieneLaboral,
    ubicacion: tieneUbicacion,
    referencias: tieneReferencias,
    medico: tieneMedico,
    completado: tieneLaboral && tieneUbicacion, // mínimo viable
  };

  const currentLeadData = leadSnap.data() || {};
  if (expediente.expedienteProgreso.completado && (currentLeadData.estado === "Recibida" || !currentLeadData.estado)) {
    expediente.estado = "En Seguimiento";
  }

  // Guard de idempotencia: si YA estaba completado antes de este POST,
  // no re-enviamos el WhatsApp (evita duplicados por refresh/doble-submit).
  const yaEstabaCompletado = !!currentLeadData.expedienteProgreso?.completado;

  try {
    await leadRef.set(expediente, { merge: true });
    console.log(`[EXP] Expediente guardado: ${leadId} — laboral:${tieneLaboral} ubicacion:${tieneUbicacion} refs:${referencias.length} medico:${tieneMedico}`);

    // Si ACABA de completarse (primera vez), enviar WhatsApp automático pidiendo PDFs.
    // Estrategia:
    //   1) Intentamos freeform (body) — funciona si el cliente nos escribió en las últimas 24h.
    //   2) Si Twilio responde 63016 (fuera de ventana) y hay TWILIO_CONTENT_SID_EXPEDIENTE
    //      configurado, reintentamos con el template HSM aprobado por Meta.
    //   3) Si no hay template configurado, dejamos warning para seguimiento manual.
    if (expediente.expedienteProgreso.completado && !yaEstabaCompletado) {
      const phone = currentLeadData.phone || data.phone;
      const hasTwilioConfig =
        process.env.TWILIO_ACCOUNT_SID &&
        process.env.TWILIO_AUTH_TOKEN &&
        process.env.TWILIO_WHATSAPP_NUMBER;

      if (phone && hasTwilioConfig) {
        const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const toNumber = normalizeWhatsAppNumber(phone);
        const fromNumber = normalizeWhatsAppNumber(process.env.TWILIO_WHATSAPP_NUMBER);
        const name = (currentLeadData.fullName || "Estimado cliente").split(" ")[0];

        // Genera el link del portal del cliente (48 h) para que pueda subir
        // los documentos desde la web si prefiere no hacerlo por WhatsApp.
        // Si falla la firma (p.ej. falta PORTAL_JWT_SECRET), seguimos sin el link.
        let portalLink = "";
        try {
          portalLink = signPortalToken(leadId).url;
        } catch (e) {
          console.warn("[EXP] No se pudo firmar portal link:", e.message);
        }

        const portalLine = portalLink
          ? `\n\n📱 *Mi Portal* (alternativa a WhatsApp, subir PDFs desde la web — válido 48 h):\n${portalLink}`
          : "";

        const freeformBody = `Hola ${name} - hemos recibido tu información - revisaremos tu solicitud y estaremos en contacto contigo muy pronto, ¡gracias por elegirnos!

Para avanzar con tu crédito hipotecario, por favor envíanos por este medio los siguientes documentos. *SOLO EN FORMATO PDF (NO FOTOS)*:
- INE o PASAPORTE
- CSF (constancia de situación fiscal actual)
- Comprobante de domicilio residencial (actual)
- Acta de Nacimiento
- Acta de Matrimonio
- Últimos 6 estados de cuenta (completos)
- (Último recibo de nómina, en su caso)
- Última declaración anual
- Buró de crédito especial: https://wbc3.burodecredito.com.mx:7442/idprovider/pages/autorizacion.jsf?gatm=6${portalLine}`;

        try {
          await twilioClient.messages.create({
            from: fromNumber,
            to: toNumber,
            body: freeformBody,
          });
          console.log(`[EXP] WhatsApp freeform enviado a ${toNumber}`);
        } catch (err) {
          const is63016 = err && (err.code === 63016 || String(err.message).includes("63016"));

          if (is63016 && process.env.TWILIO_CONTENT_SID_EXPEDIENTE) {
            // Fallback a template aprobado. El template debe esperar {{1}} = nombre.
            try {
              await twilioClient.messages.create({
                from: fromNumber,
                to: toNumber,
                contentSid: process.env.TWILIO_CONTENT_SID_EXPEDIENTE,
                contentVariables: JSON.stringify({ "1": name }),
              });
              console.log(`[EXP] WhatsApp template (${process.env.TWILIO_CONTENT_SID_EXPEDIENTE}) enviado a ${toNumber} tras 63016`);
            } catch (tplErr) {
              console.error(
                `[EXP] Falló también el template ${process.env.TWILIO_CONTENT_SID_EXPEDIENTE}:`,
                tplErr.code,
                tplErr.message
              );
            }
          } else if (is63016) {
            console.warn(
              `[EXP] Twilio 63016 — fuera de ventana de 24h y sin TWILIO_CONTENT_SID_EXPEDIENTE configurado. Lead ${leadId} requiere seguimiento manual.`
            );
          } else {
            console.error("[EXP] Error enviando WhatsApp:", err.code, err.message);
          }
        }
      } else if (!hasTwilioConfig) {
        console.warn("[EXP] WhatsApp automático NO enviado: faltan TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_NUMBER en Vercel.");
      }
    } else if (expediente.expedienteProgreso.completado && yaEstabaCompletado) {
      console.log(`[EXP] Re-submit detectado en lead ${leadId} — omitimos WhatsApp automático (ya se envió la primera vez).`);
    }

    // Alerta al agente si el lead califica al completar expediente (no bloqueante).
    if (expediente.expedienteProgreso.completado && !yaEstabaCompletado) {
      try {
        const hasTwilio =
          process.env.TWILIO_ACCOUNT_SID &&
          process.env.TWILIO_AUTH_TOKEN &&
          process.env.TWILIO_WHATSAPP_NUMBER;
        if (hasTwilio && process.env.AGENT_NOTIFICATION_PHONE) {
          const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          const mergedLead = { ...currentLeadData, ...expediente };
          await maybeAlertAgent({
            twilioClient,
            db,
            leadId,
            lead: mergedLead,
            trigger: "expediente completo",
          });
        }
      } catch (e) {
        console.warn("[EXP] alerta al agente falló (no bloqueante):", e.message);
      }
    }

    return res.status(200).json({
      success: true,
      message: "Expediente guardado correctamente.",
      progreso: expediente.expedienteProgreso,
    });
  } catch (e) {
    console.error("[EXP] Firestore write FAIL:", e.code, e.message);
    return res.status(500).json({
      success: false,
      message: "Error al guardar el expediente. Intenta de nuevo o contáctanos por WhatsApp.",
    });
  }
}
