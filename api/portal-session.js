/**
 * /api/portal-session.js
 * Valida el JWT del portal y devuelve el estado actual del expediente
 * del lead, incluyendo el checklist dinámico de documentos.
 *
 * El checklist se calcula según `perfilLaboral` del lead:
 *   - Asalariado → incluye "Últimos 3 recibos de nómina"
 *   - PFAE       → incluye "Última declaración anual"
 *   - Sin perfil → incluye ambos con una nota indicando al usuario que
 *                  su asesor definirá cuál aplica.
 *
 * Los documentos que el cliente haya subido por WhatsApp también cuentan
 * como recibidos (se detectan vía `classification`, misma convención que
 * el webhook).
 *
 * Body:
 *   { token: string }
 *
 * Response:
 *   {
 *     success: true,
 *     lead: { nombre, telefono (últimos 4), estado, loanPurpose, propertyValue },
 *     expediente: { completado, ...progreso },
 *     checklist: [{ key, label, required, subido, uploadedAt, downloadUrl, source }],
 *     proximoPaso: string,
 *     expedienteLink?: string,   // si aún no completó expediente
 *   }
 */

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
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
      });
  db = getFirestore(app);
} catch (e) {
  console.error("[PORTAL-SESSION] Firebase Admin INIT ERROR:", e.message);
}

// ── Checklist por tipo de documento ──────────────────────────
// `classifications` es el set que cuenta como "recibido" cuando el
// classifier de Claude etiqueta un archivo subido por WhatsApp. DEBE
// coincidir con los valores que usa whatsapp-webhook.js en su REQUIRED_DOCS_*.
export const PORTAL_DOC_TYPES = [
  // Comunes (todos los perfiles)
  {
    key: "ine",
    label: "INE o Pasaporte",
    required: true,
    forPerfil: "all",
    classifications: ["INE", "identificacion_otra"],
  },
  {
    key: "acta_nacimiento",
    label: "Acta de Nacimiento",
    required: true,
    forPerfil: "all",
    classifications: ["acta_nacimiento"],
  },
  {
    key: "acta_matrimonio",
    label: "Acta de Matrimonio (solo si aplica)",
    required: false,
    forPerfil: "all",
    classifications: ["acta_matrimonio"],
  },
  {
    key: "comprobante_domicilio",
    label: "Comprobante de Domicilio (no mayor a 3 meses)",
    required: true,
    forPerfil: "all",
    classifications: ["comprobante_domicilio"],
  },
  {
    key: "csf",
    label: "Constancia de Situación Fiscal (CSF)",
    required: true,
    forPerfil: "all",
    classifications: ["rfc"],
  },
  {
    key: "buro",
    label: "Reporte de Buró de Crédito Especial",
    required: true,
    forPerfil: "all",
    classifications: ["autorizacion_buro"],
  },
  {
    key: "estados_cuenta",
    label: "Últimos 6 estados de cuenta bancarios",
    required: true,
    forPerfil: "all",
    classifications: ["estado_cuenta"],
  },
  // Asalariado
  {
    key: "recibos_nomina",
    label: "Últimos 3 recibos de nómina",
    required: true,
    forPerfil: "asalariado",
    classifications: ["recibo_nomina"],
  },
  // PFAE
  {
    key: "declaracion_anual",
    label: "Última declaración anual de impuestos",
    required: true,
    forPerfil: "pfae",
    classifications: ["declaracion_anual"],
  },
];

export function filterChecklistForPerfil(perfilLaboral) {
  return PORTAL_DOC_TYPES.filter(
    (d) => d.forPerfil === "all" || d.forPerfil === perfilLaboral
  );
}

// Mapea docs recibidos (de leadData.documentos) a qué keys del checklist cubren.
// Devuelve un Map<docKey, docEntry> con el primer match por cada key.
function indexReceivedDocs(documentos, checklist) {
  const map = new Map();
  const docs = Array.isArray(documentos) ? documentos : [];
  for (const item of checklist) {
    // Primero busca un match específico del portal (portalTipo === item.key).
    // Esto es más preciso que la classification cuando el doc fue subido por
    // el portal (porque INE y acta_matrimonio comparten la misma classification).
    let hit = docs.find((d) => d?.portalTipo === item.key);
    if (!hit) {
      hit = docs.find(
        (d) => d?.classification && item.classifications.includes(d.classification)
      );
    }
    if (hit) map.set(item.key, hit);
  }
  return map;
}

function mask4(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (d.length < 4) return "";
  return "••• •• " + d.slice(-4);
}

function firstName(fullName) {
  const s = String(fullName || "").trim();
  if (!s) return "";
  return s.split(/\s+/)[0];
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  if (!db) return res.status(500).json({ error: "Firestore no disponible" });
  if (!process.env.PORTAL_JWT_SECRET) {
    return res.status(500).json({ error: "Portal no configurado" });
  }

  // ── 1) Validar JWT ──
  const { token } = req.body || {};
  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "Token faltante" });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.PORTAL_JWT_SECRET, { algorithms: ["HS256"] });
  } catch (e) {
    const reason = e.name === "TokenExpiredError" ? "expirado" : "inválido";
    console.warn(`[PORTAL-SESSION] JWT ${reason}: ${e.message}`);
    return res.status(401).json({ error: `Enlace ${reason}. Pide uno nuevo a tu asesor.` });
  }

  const leadId = payload?.leadId;
  if (!leadId || typeof leadId !== "string") {
    return res.status(401).json({ error: "Token malformado" });
  }

  // ── 2) Cargar lead ──
  let leadSnap;
  try {
    leadSnap = await db.collection("solicitudes").doc(leadId).get();
  } catch (e) {
    console.error("[PORTAL-SESSION] Firestore read FAIL:", e.message);
    return res.status(500).json({ error: "Error al leer tu expediente" });
  }

  if (!leadSnap.exists) {
    return res.status(404).json({ error: "Expediente no encontrado" });
  }

  const lead = leadSnap.data() || {};

  // ── 3) Construir checklist según perfil ──
  const perfil = lead.perfilLaboral || null; // "asalariado" | "pfae" | null
  const checklistBase = filterChecklistForPerfil(perfil || "asalariado"); // por defecto asalariado
  // Si no hay perfil, incluir ambos extras con una nota visual en el front
  const checklistFull = perfil
    ? checklistBase
    : PORTAL_DOC_TYPES.filter((d) => d.forPerfil === "all" || true); // todos, se avisa

  const receivedMap = indexReceivedDocs(lead.documentos, checklistFull);

  const checklist = checklistFull.map((item) => {
    const received = receivedMap.get(item.key);
    return {
      key: item.key,
      label: item.label,
      required: item.required,
      // Si el perfil no está definido, marcamos los docs específicos como "informativos"
      onlyIf: !perfil && item.forPerfil !== "all" ? `Aplica si eres ${item.forPerfil}` : null,
      subido: !!received,
      uploadedAt: received?.uploadedAt || received?.receivedAt || null,
      downloadUrl: received?.url || null,
      source: received?.source || (received ? "whatsapp" : null),
    };
  });

  // ── 4) Calcular estado + próximo paso ──
  const expedienteCompletado = !!lead.expedienteProgreso?.completado;
  const requiredMissing = checklist.filter((c) => c.required && !c.subido).length;
  const estadoLead = lead.estado || "Recibida";

  let proximoPaso;
  if (!expedienteCompletado) {
    proximoPaso = "Completa tu expediente (ubicación, empresa, seguro de vida) en 3 minutos.";
  } else if (requiredMissing > 0) {
    proximoPaso = `Te faltan ${requiredMissing} documento${requiredMissing === 1 ? "" : "s"} obligatorio${requiredMissing === 1 ? "" : "s"} para que tu asesor pueda enviar tu solicitud al banco.`;
  } else {
    proximoPaso = "Tu expediente está completo. Tu asesor lo está revisando y te contactará pronto.";
  }

  // Link al formulario de expediente si aún no lo completó
  const base = (process.env.PUBLIC_SITE_URL || "https://homeloans.mx").replace(/\/$/, "");
  const expedienteLink = expedienteCompletado
    ? null
    : `${base}/completar-expediente.html?leadId=${leadId}`;

  // ── 5) Auditar acceso ──
  try {
    await db
      .collection("solicitudes")
      .doc(leadId)
      .collection("portalAccessLog")
      .add({
        action: "portal_viewed",
        at: new Date(),
        ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "",
        userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
      });
  } catch (e) {
    console.warn("[PORTAL-SESSION] No se pudo auditar:", e.message);
  }

  // ── 6) Responder ──
  return res.status(200).json({
    success: true,
    lead: {
      nombre: firstName(lead.fullName),
      telefonoMascara: mask4(lead.phone),
      estado: estadoLead,
      loanPurpose: lead.loanPurpose || null,
      propertyValue: lead.propertyValue || null,
      perfilLaboral: perfil,
    },
    expediente: {
      completado: expedienteCompletado,
      progreso: lead.expedienteProgreso || null,
    },
    checklist,
    proximoPaso,
    expedienteLink,
    advertenciaPerfil: !perfil
      ? "Aún no nos has confirmado si eres asalariado o PFAE. Tu asesor lo definirá contigo; mientras, puedes subir todos los documentos comunes."
      : null,
  });
}
