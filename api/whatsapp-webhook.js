/**
 * /api/whatsapp-webhook.js
 * Chatbot de WhatsApp para HomeLoans.mx
 * Twilio → Claude (Isaac) → Firestore Admin + Firebase Storage → Twilio
 *
 * Funcionalidades:
 * - Qualifica leads conversacionalmente (5 preguntas).
 * - Recibe imágenes y PDFs: sube a Storage y clasifica con Claude Vision.
 * - Respeta pausa del bot cuando un agente toma control desde el CRM (24h).
 */

import Anthropic from "@anthropic-ai/sdk";
import twilio from "twilio";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

// ── Firebase Admin SDK ──────────────────────────────────────
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
  console.log("[WH] Firebase Admin OK — project:", process.env.FIREBASE_ADMIN_PROJECT_ID);
} catch (e) {
  console.error("[WH] Firebase Admin INIT ERROR:", e.message);
}

// ── Anthropic ───────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── TwiML helper ────────────────────────────────────────────
function buildTwiML(message) {
  const MR =
    twilio?.twiml?.MessagingResponse ||
    twilio?.default?.twiml?.MessagingResponse;
  if (MR) {
    const r = new MR();
    if (message) r.message(message);
    return r.toString();
  }
  const safe = (message || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${message ? `<Message>${safe}</Message>` : ""}</Response>`;
}

function sendTwiML(res, message) {
  res.setHeader("Content-Type", "text/xml");
  return res.status(200).send(buildTwiML(message));
}

// ── Sistema prompt ──────────────────────────────────────────
const SYSTEM_PROMPT = `Eres Isaac, asesor hipotecario senior de HomeLoans.mx en CDMX. Te especializas en propiedades de $10M+ MXN en zonas premium: Polanco, Lomas de Chapultepec, Bosques de las Lomas, Lomas de Vistahermosa, Interlomas, Santa Fe y Pedregal.

Trabajamos EXCLUSIVAMENTE con Santander, Banamex, HSBC, Mifel, Banorte y Scotiabank. NO trabajamos con BBVA. Si el prospecto pregunta por bancos, menciona solo los que sí manejamos.

Tu misión es calificar prospectos haciendo estas preguntas de forma conversacional, una a la vez (nunca todas juntas):

PREGUNTA 0 — Propósito (SIEMPRE la primera):
  "¿Está buscando financiamiento para comprar una propiedad, o desea refinanciar/mejorar condiciones de un crédito que ya tiene?"
  - Si es COMPRA → flujo estándar (preguntas 1-5).
  - Si es REFINANCIAMIENTO → pregunta adicionalmente:
      A) ¿Con qué banco tiene el crédito actual?
      B) ¿Cuál es la tasa que paga actualmente?
      C) ¿Cuál es el saldo pendiente aproximado?
    Luego continúa con preguntas 1, 2, 4 y 5 (el enganche no aplica en refi).

Preguntas estándar (compra):
1. Valor aproximado de la propiedad que busca
2. Colonia o zona de interés
3. Enganche disponible (monto en pesos)
4. Ingresos mensuales comprobables
5. Historial crediticio (Excelente / Bueno / Regular / Sin historial)

Reglas estrictas:
- Sé profesional, amable y MUY conciso. Máximo 2-3 oraciones por respuesta.
- Responde SIEMPRE en español.
- TASAS: NUNCA menciones porcentajes menores al 8.95% anual (tasa mínima real del mercado hoy). Si el cliente pregunta antes de tener su perfil completo, di: "Las tasas actuales arrancan desde 8.95% anual. Para darte la cotización exacta necesito conocer tu perfil — ¿empezamos?" Solo después de los 5 datos puedes dar un rango estimado entre 8.95% y 11.50% según su perfil.
- La EDAD MÁXIMA permitida es de 80 años (Edad actual + Plazo del crédito). Ejemplo: si el cliente tiene 71 años, el plazo máximo que se le puede ofrecer es de 9 años. Si un cliente no cumple, infórmale amablemente.
- Si el prospecto pregunta algo fuera de tema, redirige amablemente hacia la calificación.
- Cuando tengas los 5 datos, agradece y dile que un asesor lo contactará en menos de 24 horas.

INSTRUCCIÓN ESPECIAL — cuando hayas recopilado todos los datos necesarios según el propósito, incluye AL FINAL de tu respuesta, en una línea separada, el siguiente bloque (el usuario nunca lo verá):

Para COMPRA:
LEAD_DATA:{"loanPurpose":"compra","propertyValue":NUMERO_SIN_COMAS,"colonia":"TEXTO","downPayment":NUMERO_SIN_COMAS,"monthlyIncome":NUMERO_SIN_COMAS,"creditScore":"TEXTO"}

Para REFINANCIAMIENTO:
LEAD_DATA:{"loanPurpose":"refinanciamiento","propertyValue":NUMERO_SIN_COMAS,"colonia":"TEXTO","downPayment":0,"monthlyIncome":NUMERO_SIN_COMAS,"creditScore":"TEXTO","currentBank":"NOMBRE_BANCO","currentRate":NUMERO_DECIMAL,"currentBalance":NUMERO_SIN_COMAS}

Solo incluye LEAD_DATA cuando tengas todos los valores confirmados para el tipo de operación.`;

const MAX_HISTORY = 20;
const CLASSIFY_PROMPT = `Analiza este documento mexicano relacionado con un trámite hipotecario. Clasifícalo en UNA de estas categorías (usa EXACTAMENTE el slug entre comillas):
- "INE" (credencial de elector del INE/IFE)
- "curp" (constancia de CURP)
- "acta_nacimiento" (acta de nacimiento)
- "acta_matrimonio" (acta de matrimonio)
- "carta_patronal" (carta de la empresa empleadora con antigüedad, puesto, sueldo)
- "recibo_nomina" (recibo de nómina / CFDI de nómina)
- "estado_cuenta" (estado de cuenta bancario, de inversión o afore PERSONAL; NO del crédito hipotecario)
- "estado_cuenta_credito" (estado de cuenta del crédito hipotecario vigente)
- "tabla_amortizacion" (tabla de amortización del crédito hipotecario)
- "comprobante_domicilio" (CFE, Telmex, agua, predial, internet)
- "escritura" (escritura pública de propiedad)
- "rfc" (constancia de situación fiscal / CSF)
- "declaracion_anual" (acuse de declaración anual del SAT)
- "autorizacion_buro" (autorización firmada para consulta a buró de crédito)
- "identificacion_otra" (pasaporte, cédula profesional, licencia)
- "otro" (cualquier otro documento)

Responde EXCLUSIVAMENTE con JSON válido (sin markdown, sin texto adicional):
{"classification":"<categoria>","summary":"<descripción breve de 1 línea, máximo 15 palabras>"}`;

// ── Utilidades ──────────────────────────────────────────────

// Canonicaliza un teléfono mexicano a 12 dígitos (52 + 10) para usar como
// parte del doc ID. Unifica los tres formatos que pueden llegar:
//   - "5512345678"              → "525512345678"   (form web, 10 dígitos)
//   - "525512345678"            → "525512345678"   (ya canónico)
//   - "5215512345678"           → "525512345678"   (Twilio legacy con "1" móvil)
//   - "whatsapp:+5215512345678" → "525512345678"
// Si el número no es mexicano reconocible, regresa los dígitos tal cual.
function canonicalMxPhone(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 10) return "52" + d;
  if (d.length === 13 && d.startsWith("521")) return "52" + d.slice(3);
  return d;
}

// Genera el doc ID canónico de whatsapp_sessions: "wa_whatsapp__<12 dígitos>".
// Este formato coincide con `sessionIdFromPhone` del CRM y `normalizeWhatsAppNumber`
// de send-whatsapp, para que los tres escriban/lean el mismo documento.
function phoneToDocId(phone) {
  const canon = canonicalMxPhone(phone);
  if (canon) return "wa_whatsapp__" + canon;
  // Fallback defensivo para números no-mexicanos
  return "wa_" + String(phone || "").replace(/\W/g, "_");
}

// Devuelve TODAS las variantes plausibles del teléfono tal como el form web
// u otras vías pudieron haberlo guardado en `solicitudes.phone`. Esto permite
// vincular un chat de WhatsApp con la solicitud original por número, sin
// crear un duplicado por diferencia de formato.
//
// Ejemplo: para WhatsApp "+5215519487025" genera:
//   - "5519487025"    (10 dígitos, lo típico del form)
//   - "525519487025"  (12 dígitos canónico)
//   - "5215519487025" (13 dígitos legacy con "1" móvil)
//   - "+525519487025", "+5215519487025", "+5519487025"
// Firestore `in` soporta hasta 30 valores, así que esta lista cabe de sobra.
function phoneSearchVariants(whatsappPhone) {
  const d = String(whatsappPhone || "").replace(/\D/g, "");
  if (!d) return [];
  const variants = new Set();
  variants.add(d);
  const ten = d.length >= 10 ? d.slice(-10) : d;
  if (ten.length === 10) {
    variants.add(ten);                 // "5519487025"
    variants.add("52" + ten);          // "525519487025"
    variants.add("521" + ten);         // "5215519487025"
    variants.add("+52" + ten);
    variants.add("+521" + ten);
    variants.add("+" + ten);
  }
  // Si llega canónico 12, agregar la versión con "1" y sin prefijo
  if (d.length === 12 && d.startsWith("52")) {
    variants.add("521" + d.slice(2));
    variants.add("+" + d);
    variants.add("+521" + d.slice(2));
  }
  // Si llega legacy 13 con "521", agregar sin el "1"
  if (d.length === 13 && d.startsWith("521")) {
    variants.add("52" + d.slice(3));
    variants.add("+" + d);
    variants.add("+52" + d.slice(3));
  }
  return [...variants];
}

// IDs "legacy" que pudieron haberse creado antes de canonicalizar.
// El webhook los revisa al primer mensaje para migrar los mensajes viejos.
function legacyDocIds(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  const ids = new Set();
  if (!d) return [];
  // Formato viejo "wa_whatsapp__521..." (Twilio con "1" móvil mexicano)
  if (d.length === 13 && d.startsWith("521")) ids.add("wa_whatsapp__" + d);
  if (d.length === 10) ids.add("wa_whatsapp__521" + d);
  if (d.length === 12 && d.startsWith("52")) ids.add("wa_whatsapp__521" + d.slice(2));
  // Formato con "whatsapp:+" literal
  const withPrefix = "wa_whatsapp__+" + d;
  ids.add(withPrefix.replace(/\W/g, "_"));
  return [...ids];
}

function parseBody(req) {
  const body = req.body;
  if (!body) return {};
  if (typeof body === "object" && !Buffer.isBuffer(body)) return body;
  const raw = Buffer.isBuffer(body) ? body.toString() : String(body);
  try {
    return JSON.parse(raw);
  } catch {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

function extractLeadData(text) {
  const marker = "LEAD_DATA:";
  const idx = text.indexOf(marker);
  if (idx === -1) return { cleanText: text.trim(), leadData: null };
  const cleanText = text.slice(0, idx).trim();
  try {
    const json = text.slice(idx + marker.length).trim();
    return { cleanText, leadData: JSON.parse(json) };
  } catch {
    return { cleanText, leadData: null };
  }
}

// ── Expediente / documentos requeridos ──────────────────────
// Checklist canónico para perfil ASALARIADO. Si el cliente es PFAE
// (profesional con actividad empresarial / honorarios), el bot NO intenta
// recolectar documentos: se pausa y escala a asesor humano.
// Cada item tiene las `classifications` que cuentan como "recibido" si el
// classifier de Claude etiqueta el archivo con alguna de ellas.
const REQUIRED_DOCS_ASALARIADO = [
  { key: "INE",                 label: "INE vigente (AMBOS lados, frente y reverso)",                                  classifications: ["INE", "identificacion_otra"] },
  { key: "curp",                label: "CURP actualizada",                                                             classifications: ["curp"] },
  { key: "acta_nacimiento",     label: "Acta de nacimiento",                                                           classifications: ["acta_nacimiento"] },
  { key: "recibos_nomina",      label: "Últimos 3 recibos de nómina (CFDI)",                                           classifications: ["recibo_nomina"] },
  { key: "carta_patronal",      label: "Carta patronal reciente (antigüedad, puesto, sueldo bruto y neto)",            classifications: ["carta_patronal"] },
  { key: "estado_cuenta",       label: "Últimos 3 estados de cuenta bancarios donde cae la nómina",                    classifications: ["estado_cuenta"] },
  { key: "comprobante_domicilio",label: "Comprobante de domicilio reciente (no mayor a 3 meses: CFE, Telmex, agua o predial)", classifications: ["comprobante_domicilio"] },
  { key: "rfc",                 label: "Constancia de situación fiscal (CSF / RFC)",                                   classifications: ["rfc"] },
  { key: "declaracion_anual",   label: "Acuse de la última declaración anual del SAT",                                 classifications: ["declaracion_anual"] },
  { key: "autorizacion_buro",   label: "Autorización firmada para consulta a buró de crédito (se la envío en PDF)",    classifications: ["autorizacion_buro"] },
];

// Extras que aplican SOLO si la operación es refinanciamiento.
const REQUIRED_DOCS_REFI_EXTRA = [
  { key: "escritura",             label: "Escritura pública de la propiedad",                 classifications: ["escritura"] },
  { key: "estado_cuenta_credito", label: "Último estado de cuenta del crédito hipotecario vigente", classifications: ["estado_cuenta_credito"] },
  { key: "tabla_amortizacion",    label: "Tabla de amortización del crédito actual",          classifications: ["tabla_amortizacion"] },
];

// Extras condicionales: sólo si el cliente declara casado bajo sociedad
// conyugal (bandera manual del asesor o inferida de la conversación).
const REQUIRED_DOCS_CASADO_EXTRA = [
  { key: "acta_matrimonio",     label: "Acta de matrimonio",                                                           classifications: ["acta_matrimonio"] },
  { key: "ine_conyuge",         label: "INE del cónyuge (ambos lados)",                                                classifications: ["INE", "identificacion_otra"], /* nota: mismo classification que INE, el asesor verifica manualmente */ requiresManualReview: true },
];

// Detecta perfil laboral en un string libre. El bot lo emite con marker
// PERFIL_LABORAL:asalariado  o  PERFIL_LABORAL:pfae  al final del mensaje.
function extractPerfilLaboral(text) {
  const marker = "PERFIL_LABORAL:";
  const idx = text.indexOf(marker);
  if (idx === -1) return { cleanText: text, perfilLaboral: null };
  const cleanText = text.slice(0, idx).trim();
  const rest = text.slice(idx + marker.length).trim().toLowerCase();
  // Primer token alfabético
  const m = rest.match(/^[a-záéíóúñ_]+/);
  const val = m ? m[0] : "";
  if (val === "asalariado" || val === "pfae") {
    return { cleanText, perfilLaboral: val };
  }
  return { cleanText, perfilLaboral: null };
}

// Devuelve un resumen breve en español de los datos que ya tenemos en la
// solicitud y la lista de documentos que aún faltan (según perfil laboral
// y propósito). Usado para inyectar contexto al system prompt de Claude.
function buildSolicitudContext(leadData) {
  if (!leadData || typeof leadData !== "object") return null;

  const hasLoanBasics =
    leadData.loanPurpose &&
    Number(leadData.propertyValue) > 0 &&
    Number(leadData.monthlyIncome) > 0;

  if (!hasLoanBasics) return null;

  const fmtMxn = (n) =>
    new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 }).format(Number(n) || 0);

  const lines = [];
  if (leadData.fullName && leadData.fullName !== "Lead WhatsApp") lines.push(`Nombre: ${leadData.fullName}`);
  if (leadData.loanPurpose)  lines.push(`Propósito: ${leadData.loanPurpose === "refinanciamiento" ? "Refinanciamiento" : "Compra"}`);
  if (leadData.propertyValue) lines.push(`Valor del inmueble: ${fmtMxn(leadData.propertyValue)}`);
  if (leadData.colonia)       lines.push(`Zona / Colonia: ${leadData.colonia}`);
  if (leadData.downPayment)   lines.push(`Enganche: ${fmtMxn(leadData.downPayment)}`);
  if (leadData.monthlyIncome) lines.push(`Ingreso mensual: ${fmtMxn(leadData.monthlyIncome)}`);
  if (leadData.creditScore)   lines.push(`Historial crediticio: ${leadData.creditScore}`);
  if (leadData.currentBank)   lines.push(`Banco actual: ${leadData.currentBank}`);
  if (leadData.currentRate)   lines.push(`Tasa actual: ${leadData.currentRate}%`);
  if (leadData.currentBalance) lines.push(`Saldo pendiente: ${fmtMxn(leadData.currentBalance)}`);

  // Perfil laboral (asalariado, pfae, o sin definir)
  const perfil = leadData.perfilLaboral || null;
  if (perfil) lines.push(`Perfil laboral: ${perfil === "asalariado" ? "Asalariado" : "PFAE (honorarios / actividad empresarial)"}`);

  // Checklist aplica sólo si el perfil es asalariado
  let checklist = [];
  if (perfil === "asalariado") {
    checklist = [...REQUIRED_DOCS_ASALARIADO];
    if (leadData.loanPurpose === "refinanciamiento") checklist.push(...REQUIRED_DOCS_REFI_EXTRA);
    if (leadData.estadoCivil === "casado_sociedad_conyugal") checklist.push(...REQUIRED_DOCS_CASADO_EXTRA);
  }

  // Documentos ya recibidos
  const docsArr = Array.isArray(leadData.documentos) ? leadData.documentos : [];
  const receivedClassifications = new Set(
    docsArr.map((d) => d?.classification).filter(Boolean)
  );

  const received = [];
  const missing = [];
  for (const req of checklist) {
    const hit = req.classifications.some((c) => receivedClassifications.has(c));
    (hit ? received : missing).push(req.label);
  }

  return {
    summary: lines.join("\n"),
    perfilLaboral: perfil,
    needsPerfilAsk: !perfil,          // Si no tenemos perfil, el bot debe preguntarlo primero
    isPfae: perfil === "pfae",        // Si es PFAE, no pedir docs, escalar a asesor
    received,
    missing,
    isComplete: perfil === "asalariado" && missing.length === 0,
  };
}

function extFromMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("jpeg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("heic")) return "heic";
  if (m.includes("pdf")) return "pdf";
  if (m.includes("mp4")) return "mp4";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("amr")) return "amr";
  return "bin";
}

// Descarga media de Twilio con Basic Auth y la sube a Storage.
async function downloadAndStoreMedia(mediaUrl, mimeType, leadId, index) {
  const auth = Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString("base64");

  const response = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${auth}` },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Twilio media download failed: ${response.status}`);
  }
  const arrayBuf = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  const ext = extFromMime(mimeType);
  const timestamp = Date.now();
  const storagePath = `leads/${leadId || "unclaimed"}/${timestamp}_${index}.${ext}`;

  const file = bucket.file(storagePath);
  await file.save(buffer, {
    contentType: mimeType,
    metadata: { metadata: { source: "whatsapp", twilioMediaUrl: mediaUrl } },
  });

  // URL firmada 365 días
  const [url] = await file.getSignedUrl({
    action: "read",
    expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
  });

  return { buffer, storagePath, url };
}

// Clasifica el documento usando Claude (Vision para imágenes, PDF para PDFs).
async function classifyDocument(buffer, mimeType) {
  const m = String(mimeType || "").toLowerCase();
  const isImage = m.startsWith("image/");
  const isPdf = m === "application/pdf" || m.includes("pdf");
  if (!isImage && !isPdf) {
    return { classification: "otro", summary: "Archivo no clasificable (audio/video)" };
  }

  const base64 = buffer.toString("base64");
  const content = [
    {
      type: isPdf ? "document" : "image",
      source: {
        type: "base64",
        media_type: isPdf ? "application/pdf" : mimeType,
        data: base64,
      },
    },
    { type: "text", text: CLASSIFY_PROMPT },
  ];

  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{ role: "user", content }],
    });
    const text = resp.content?.[0]?.text?.trim() || "{}";
    // Extrae JSON aunque venga con texto extra
    const jsonMatch = text.match(/\{[^{}]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    return {
      classification: parsed.classification || "otro",
      summary: parsed.summary || "",
    };
  } catch (e) {
    console.error("[WH] classify FAIL:", e.message);
    return { classification: "otro", summary: "No se pudo clasificar" };
  }
}

function friendlyClassificationLabel(c) {
  const map = {
    INE: "INE",
    curp: "CURP",
    acta_nacimiento: "acta de nacimiento",
    acta_matrimonio: "acta de matrimonio",
    carta_patronal: "carta patronal",
    recibo_nomina: "recibo de nómina",
    comprobante_ingresos: "comprobante de ingresos",
    estado_cuenta: "estado de cuenta",
    estado_cuenta_credito: "estado de cuenta del crédito hipotecario",
    tabla_amortizacion: "tabla de amortización",
    comprobante_domicilio: "comprobante de domicilio",
    escritura: "escritura",
    identificacion_otra: "identificación",
    rfc: "RFC / constancia de situación fiscal",
    declaracion_anual: "acuse de declaración anual",
    autorizacion_buro: "autorización de buró de crédito",
    otro: "documento",
  };
  return map[c] || "documento";
}

// ── Handler principal ───────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const body = parseBody(req);
  const incomingMessage = (body.Body || "").trim();
  const fromNumber = body.From || "";
  const numMedia = parseInt(body.NumMedia || "0", 10);

  console.log(`[WH] ▶ De: ${fromNumber} | Msg: "${incomingMessage}" | Media: ${numMedia}`);

  if (!fromNumber || (!incomingMessage && numMedia === 0)) {
    console.error("[WH] Body inválido — From:", fromNumber, "Body:", body.Body);
    return res.status(400).send("Bad Request");
  }

  if (!db) {
    console.error("[WH] Firestore Admin no inicializado — revisa FIREBASE_ADMIN_*");
    return sendTwiML(res, "Lo sentimos, hay un problema técnico. Intente más tarde.");
  }

  // ── PASO 1: Leer sesión ──
  let messages = [];
  let alreadyQualified = false;
  let crmDocId = null;
  let agentPausedUntil = null;
  const canonicalDocId = phoneToDocId(fromNumber);
  const sessionRef = db.collection("whatsapp_sessions").doc(canonicalDocId);

  // PASO 1.0: Migración de sesiones legacy.
  // Si existe un doc viejo (ej. "wa_whatsapp__521..." con el "1" móvil antes de
  // canonicalizar) y el canónico no existe o tiene menos mensajes, fusionamos
  // los mensajes y copiamos crmDocId/agentPausedUntil al canónico. Esto asegura
  // que historial del bot + mensajes del agente + mensajes nuevos del cliente
  // queden TODOS en el mismo doc, que es el que el CRM observa.
  try {
    const legacyIds = legacyDocIds(fromNumber).filter((id) => id !== canonicalDocId);
    if (legacyIds.length > 0) {
      const canonSnap = await sessionRef.get();
      const canonMsgs = canonSnap.exists ? (canonSnap.data().messages || []) : [];
      for (const legacyId of legacyIds) {
        const legacyRef = db.collection("whatsapp_sessions").doc(legacyId);
        const legacySnap = await legacyRef.get();
        if (!legacySnap.exists) continue;
        const legacyData = legacySnap.data() || {};
        const legacyMsgs = legacyData.messages || [];
        if (legacyMsgs.length === 0) continue;
        // Fusiona deduplicando por (role + content + at)
        const seen = new Set(canonMsgs.map((m) => `${m.role}|${m.content}|${m.at || ""}`));
        const merged = [...canonMsgs];
        for (const m of legacyMsgs) {
          const k = `${m.role}|${m.content}|${m.at || ""}`;
          if (!seen.has(k)) { merged.push(m); seen.add(k); }
        }
        merged.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
        const migrationPayload = { messages: merged };
        if (legacyData.crmDocId && !canonSnap.data()?.crmDocId) migrationPayload.crmDocId = legacyData.crmDocId;
        if (legacyData.agentPausedUntil) migrationPayload.agentPausedUntil = legacyData.agentPausedUntil;
        if (legacyData.qualified) migrationPayload.qualified = true;
        if (legacyData.phone && !canonSnap.data()?.phone) migrationPayload.phone = legacyData.phone;
        await sessionRef.set(migrationPayload, { merge: true });
        // Marca el doc legacy como migrado para que no se procese dos veces
        await legacyRef.set({ migratedTo: canonicalDocId, migratedAt: FieldValue.serverTimestamp() }, { merge: true });
        console.log(`[WH] MIGRATION — ${legacyId} → ${canonicalDocId} (${legacyMsgs.length} msgs fusionados)`);
      }
    }
  } catch (e) {
    console.error("[WH] MIGRATION FAIL (non-fatal):", e.message);
  }

  let rawMessages = [];
  try {
    const snap = await sessionRef.get();
    if (snap.exists) {
      const d = snap.data();
      rawMessages = (d.messages || []).filter(
        (m) => m && m.role && (m.role === "user" || m.role === "assistant" || m.role === "agent")
      );
      // Para Claude: mapeamos los mensajes del agente a "assistant" con prefijo
      // identificador, para que el bot tenga contexto completo y no se contradiga
      // ni repita lo que el asesor humano ya dijo.
      messages = rawMessages.map((m) => {
        if (m.role === "agent") {
          return {
            role: "assistant",
            content: `[MENSAJE DEL ASESOR HUMANO]: ${m.content}`,
          };
        }
        return { role: m.role, content: m.content };
      });
      alreadyQualified = d.qualified || false;
      crmDocId = d.crmDocId || null;
      agentPausedUntil = d.agentPausedUntil?.toDate
        ? d.agentPausedUntil.toDate()
        : d.agentPausedUntil
        ? new Date(d.agentPausedUntil)
        : null;
    }
    console.log(
      `[WH] PASO 1 OK — hist:${messages.length} calif:${alreadyQualified} crmDoc:${crmDocId} pausedUntil:${agentPausedUntil?.toISOString?.() || "none"}`
    );
  } catch (e) {
    console.error("[WH] PASO 1 FAIL — Firestore read:", e.code, e.message);
    return sendTwiML(res, "Disculpe, tuvimos un problema al leer su sesión. Intente de nuevo.");
  }

  const botPaused = agentPausedUntil && agentPausedUntil > new Date();

  // ── PASO 1b: Primer mensaje — enlazar a solicitud existente o crear lead ──
  // CRÍTICO: el form web puede guardar el teléfono en múltiples formatos
  // (10 dígitos, 12 con "52", con "+52", con "1" móvil, etc). Intentamos
  // TODAS las variantes plausibles antes de crear un duplicado. Si por alguna
  // razón ninguna variante exacta matchea (p.ej. el form guardó con guiones),
  // escaneamos como fallback los últimos leads y canonicalizamos en memoria.
  const isFirstMessage = messages.length === 0 && !crmDocId;
  if (isFirstMessage) {
    try {
      const variants = phoneSearchVariants(fromNumber);
      const canonFrom = canonicalMxPhone(fromNumber);
      const leadsRef = db.collection("solicitudes");

      let foundDocId = null;
      if (variants.length) {
        // Firestore `in` acepta hasta 30 valores. Partimos por si hay más.
        for (let i = 0; i < variants.length && !foundDocId; i += 30) {
          const chunk = variants.slice(i, i + 30);
          const snap = await leadsRef.where("phone", "in", chunk).limit(1).get();
          if (!snap.empty) foundDocId = snap.docs[0].id;
        }
      }

      // Fallback defensivo: si no matcheó ninguna variante exacta, escaneamos
      // los últimos 200 leads y comparamos canonicalizando. Costoso pero se
      // ejecuta UNA sola vez por conversación y protege contra formatos raros.
      if (!foundDocId && canonFrom) {
        const recentSnap = await leadsRef
          .orderBy("fecha", "desc")
          .limit(200)
          .get();
        for (const doc of recentSnap.docs) {
          const p = doc.data()?.phone;
          if (!p) continue;
          if (canonicalMxPhone(p) === canonFrom) {
            foundDocId = doc.id;
            console.log(`[WH] PASO 1b — match por canonicalización con lead ${doc.id} (phone guardado "${p}")`);
            break;
          }
        }
      }

      if (foundDocId) {
        crmDocId = foundDocId;
        console.log(`[WH] PASO 1b OK — Lead existente vinculado: ${crmDocId}`);
      } else {
        const phone = canonFrom || fromNumber.replace(/\D/g, "");
        const docRef = await leadsRef.add({
          fullName: "Lead WhatsApp",
          phone,
          primerMensaje: incomingMessage || "(adjunto archivo)",
          source: "whatsapp_chatbot",
          estado: "Recibida",
          fecha: FieldValue.serverTimestamp(),
        });
        crmDocId = docRef.id;
        console.log(`[WH] PASO 1b OK — Lead inicial creado (no match por tel): ${crmDocId}`);
      }
    } catch (e) {
      console.error("[WH] PASO 1b FAIL:", e.code, e.message, e.stack);
    }
  }

  // ── PASO 2: Procesar media (si hay) ──
  let mediaDocs = [];
  if (numMedia > 0 && bucket) {
    for (let i = 0; i < numMedia; i++) {
      const url = body[`MediaUrl${i}`];
      const mime = body[`MediaContentType${i}`] || "application/octet-stream";
      if (!url) continue;
      try {
        const { buffer, storagePath, url: signedUrl } = await downloadAndStoreMedia(
          url,
          mime,
          crmDocId,
          i
        );
        const { classification, summary } = await classifyDocument(buffer, mime);
        mediaDocs.push({
          url: signedUrl,
          storagePath,
          mimeType: mime,
          classification,
          summary,
          filename: `whatsapp_${Date.now()}_${i}.${extFromMime(mime)}`,
          uploadedAt: new Date().toISOString(),
          source: "whatsapp",
        });
        console.log(`[WH] PASO 2 OK — media ${i}: ${classification}`);
      } catch (e) {
        console.error(`[WH] PASO 2 FAIL media ${i}:`, e.message);
      }
    }

    if (mediaDocs.length > 0 && crmDocId) {
      try {
        const leadSnapForUpdate = await db.collection("solicitudes").doc(crmDocId).get();
        const leadData = leadSnapForUpdate.data() || {};
        
        const updatePayload = {
          documentos: FieldValue.arrayUnion(...mediaDocs),
          lastDocumentAt: FieldValue.serverTimestamp(),
        };

        if (leadData.estado === "Recibida" || !leadData.estado) {
            updatePayload.estado = "En Seguimiento";
        }

        await db.collection("solicitudes").doc(crmDocId).set(updatePayload, { merge: true });
      } catch (e) {
        console.error("[WH] PASO 2 persist FAIL:", e.code, e.message);
      }
    }
  }

  // ── PASO 3: Decidir respuesta ──
  // Si el bot está pausado (agente tomó control explícitamente), solo registramos el mensaje sin responder via Claude.
  if (botPaused) {
    if (incomingMessage) {
      // Usamos arrayUnion para NO sobrescribir mensajes del agente que
      // puedan haber llegado en paralelo desde send-whatsapp.js.
      const userMsg = {
        role: "user",
        content: incomingMessage,
        at: new Date().toISOString(),
      };
      try {
        await sessionRef.set(
          {
            messages: FieldValue.arrayUnion(userMsg),
            lastActivity: FieldValue.serverTimestamp(),
            lastInboundAt: FieldValue.serverTimestamp(),
            unreadCount: FieldValue.increment(1),
            phone: fromNumber,
            ...(crmDocId && { crmDocId }),
          },
          { merge: true }
        );
      } catch (e) {
        console.error("[WH] paused session write FAIL:", e.message);
      }
      // También actualizamos el lead para el contador de no-leídos del CRM
      if (crmDocId) {
        try {
          await db.collection("solicitudes").doc(crmDocId).set(
            {
              unreadWhatsapp: FieldValue.increment(1),
              lastInboundAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        } catch {}
      }
    }
    console.log("[WH] Bot pausado — sin respuesta automática");
    // Si llegaron docs, igual mandamos un acuse corto
    if (mediaDocs.length > 0) {
      const labels = [...new Set(mediaDocs.map((d) => friendlyClassificationLabel(d.classification)))];
      return sendTwiML(res, `Recibimos su ${labels.join(" y ")}, gracias. Un asesor le responderá pronto.`);
    }
    return sendTwiML(res, "");
  }

  // ── Revisar estado de la solicitud y del expediente de documentos ──
  // Cargamos el lead completo si existe para: (a) saber si ya llenó la
  // solicitud web (tenemos propósito, valor y ingreso → ya está calificado
  // aunque `qualified` en la sesión esté en false), y (b) construir el
  // checklist de documentos pendientes.
  let expedienteDone = false;
  let expedienteLink = "";
  let solicitudCtx = null;
  if (crmDocId) {
    try {
      const leadSnap = await db.collection("solicitudes").doc(crmDocId).get();
      const data = leadSnap.data() || {};
      expedienteDone = !!data.expedienteProgreso?.completado;
      const base = (process.env.PUBLIC_SITE_URL || "https://homeloans.mx").replace(/\/$/, "");
      expedienteLink = `${base}/completar-expediente.html?leadId=${crmDocId}`;

      solicitudCtx = buildSolicitudContext(data);
      // Si la solicitud web ya trae los datos clave, tratamos al lead como
      // calificado aunque la sesión no lo marque así todavía. Esto evita
      // que el bot vuelva a preguntar propósito / valor / ingreso.
      if (solicitudCtx && !alreadyQualified) {
        console.log(`[WH] Lead ya calificado vía solicitud web (crmDocId=${crmDocId}). Forzando alreadyQualified=true.`);
        alreadyQualified = true;
      }
    } catch (e) {
      console.error("[WH] no se pudo leer solicitud:", e.message);
    }
  }

  // ── PASO 4: Llamar a Claude ──
  const userMsgForClaude =
    incomingMessage ||
    (mediaDocs.length > 0
      ? `(El cliente adjuntó ${mediaDocs.length} archivo(s): ${mediaDocs
          .map((d) => friendlyClassificationLabel(d.classification))
          .join(", ")})`
      : "");

  messages.push({ role: "user", content: userMsgForClaude });

  let dynamicSystemPrompt = SYSTEM_PROMPT;
  if (alreadyQualified) {
    // Construimos los bloques de contexto dinámicos
    const datosBlock = solicitudCtx
      ? `DATOS YA CONFIRMADOS DEL PROSPECTO (NO LOS VUELVAS A PREGUNTAR):
${solicitudCtx.summary}`
      : "";

    // Ramificación principal: preguntar perfil / escalar PFAE / recolectar docs asalariado
    let flujoBlock = "";
    if (solicitudCtx?.needsPerfilAsk) {
      flujoBlock = `FLUJO ACTUAL — PREGUNTAR PERFIL LABORAL (CRÍTICO, ES LO PRIMERO).
Aún NO sabemos cómo comprueba ingresos este prospecto. Antes de hacer cualquier otra cosa, saluda por su nombre si lo tienes y hazle EXACTAMENTE esta pregunta, en UNA sola línea:

"Perfecto, para armar su expediente necesito saber cómo comprueba ingresos: ¿es asalariado (recibe nómina con CFDI) o PFAE (honorarios / actividad empresarial)?"

Cuando el cliente responda, clasifica su respuesta:
- Si menciona "nómina", "empleado", "asalariado", "trabajo en empresa", "me pagan sueldo" → emite PERFIL_LABORAL:asalariado
- Si menciona "honorarios", "factura", "pfae", "freelance", "consultoría", "independiente", "mi negocio", "empresa propia", "accionista" → emite PERFIL_LABORAL:pfae

INSTRUCCIÓN DE MARKER (el cliente NO lo verá):
Al final de tu próxima respuesta, en una línea aparte, incluye:
PERFIL_LABORAL:asalariado    (o)    PERFIL_LABORAL:pfae

Solo emite el marker cuando estés seguro de la respuesta. Si es ambigua, pide clarificación.`;
    } else if (solicitudCtx?.isPfae) {
      flujoBlock = `FLUJO ACTUAL — PROSPECTO PFAE, ESCALAR A ASESOR HUMANO.
Este prospecto comprueba ingresos como PFAE. Por la complejidad de su expediente (actas constitutivas, declaraciones anuales, estados financieros, etc.), NO vamos a recolectar documentos por WhatsApp. Responde EXACTAMENTE algo como:

"Gracias. Como PFAE, su expediente requiere documentación especializada. Un asesor hipotecario senior de HomeLoans.mx lo contactará hoy mismo por este mismo WhatsApp para armar su expediente paso a paso. Mientras tanto, si tiene dudas puntuales, aquí estoy."

Después de enviar ese mensaje, NO sigas pidiendo documentos ni hagas preguntas adicionales. Solo responde dudas puntuales si las hace.`;
    } else if (solicitudCtx?.isComplete) {
      flujoBlock = `FLUJO ACTUAL — EXPEDIENTE COMPLETO.
Ya recibimos todos los documentos del expediente asalariado. Agradece y avisa que un asesor está revisando su expediente y lo contactará en las próximas 24h con la cotización formal. No pidas nada más.`;
    } else if (solicitudCtx) {
      flujoBlock = `FLUJO ACTUAL — RECOLECCIÓN DE DOCUMENTOS (ASALARIADO).

YA RECIBIDOS: ${solicitudCtx.received.length ? solicitudCtx.received.join("; ") : "ninguno todavía"}.
FALTAN: ${solicitudCtx.missing.join("; ")}.

TU OBJETIVO: pedir UN documento a la vez, en el orden exacto de "FALTAN", empezando por el primero.

Reglas:
- Saluda por su nombre sólo en el PRIMER mensaje del flujo de documentos. Después no repitas el saludo.
- Pide UN solo documento por mensaje. Nunca enlistes varios a la vez.
- Cuando el cliente envíe un archivo, confirma con "Recibido: [nombre del documento]." y de inmediato pide el SIGUIENTE pendiente.
- Acepta PDF, JPG o PNG. Si se ve borroso/cortado, pídelo de nuevo amablemente.
- Para INE: pide explícitamente FRENTE Y REVERSO, en dos archivos separados si es necesario.
- Para la "Autorización de buró": avísale que se la enviaremos pre-llenada en PDF por este mismo chat para que la firme y la regrese. (El asesor humano la generará; tú solo informa y confirma cuando la regrese.)
- Si el cliente pregunta por qué pedimos X documento, responde brevemente su propósito (ej: "la carta patronal confirma tu antigüedad y sueldo para el análisis del banco").
- NO preguntes por documentos del vendedor ni del inmueble (escrituras del vendedor, predial, no-adeudo de mantenimiento): eso lo maneja el asesor humano en llamada.`;
    }

    dynamicSystemPrompt = `Eres Isaac, asesor hipotecario senior de HomeLoans.mx. El prospecto YA completó su solicitud de pre-calificación en el sitio web.

${datosBlock}

REGLAS GENERALES:
- NUNCA vuelvas a preguntar propósito del crédito, valor de la propiedad, enganche, ingreso ni historial crediticio. Ya los tenemos.
- Sé profesional, amable y MUY conciso (máximo 2-3 oraciones).
- Responde SIEMPRE en español.
- TASAS: arrancan desde 8.95% anual. Un rango exacto requiere validar el expediente completo. Nunca menciones porcentajes menores a 8.95%.
- EDAD + PLAZO no puede superar 80 años.
- Bancos con los que operamos: Santander, Banamex, HSBC, Mifel, Banorte, Scotiabank. NO trabajamos con BBVA.

${flujoBlock}`;
  }

  // Si hay mensajes del asesor humano en el historial, advertimos a Claude
  // para que complemente en lugar de contradecir o repetir.
  const hasAgentMessages = rawMessages.some((m) => m.role === "agent");
  if (hasAgentMessages) {
    dynamicSystemPrompt += `

CONTEXTO IMPORTANTE: En esta conversación también está participando un asesor humano del equipo HomeLoans.mx. Sus mensajes aparecen marcados como "[MENSAJE DEL ASESOR HUMANO]".
- NO repitas información que el asesor ya dio.
- Complementa cuando sea natural.
- Si el asesor ya prometió algo específico (una llamada, revisar algo manualmente), NO ofrezcas alternativas: confía y reitera que el asesor le dará seguimiento.
- Mantén consistencia con lo que el asesor dijo.`;
  }

  let rawReply;
  try {
    const claudeResponse = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: dynamicSystemPrompt,
      messages: messages.slice(-MAX_HISTORY),
    });
    rawReply = claudeResponse.content?.[0]?.text || "Un momento, por favor.";
    console.log(`[WH] PASO 4 OK — Claude respondió (${rawReply.length} chars)`);
  } catch (e) {
    console.error("[WH] PASO 4 FAIL — Claude:", e.status, e.message);
    return sendTwiML(
      res,
      "Disculpe, el asistente no está disponible en este momento. Intente en unos minutos."
    );
  }

  // ── PASO 5: Procesar LEAD_DATA y PERFIL_LABORAL ──
  // Claude puede emitir uno o ambos markers al final de su respuesta. Los
  // extraemos en cadena sobre el mismo texto.
  const { cleanText: afterLead, leadData } = extractLeadData(rawReply);
  const { cleanText: reply, perfilLaboral } = extractPerfilLaboral(afterLead);
  let isNowQualified = false;
  let pfaeEscalated = false; // Si se detecta PFAE, el bot se auto-pausa 24h

  if (leadData) {
    try {
      const phone = canonicalMxPhone(fromNumber) || fromNumber.replace(/\D/g, "");
      const isRefi = leadData.loanPurpose === "refinanciamiento";

      // Estado actual del lead (si existe) para NO sobreescribir datos buenos.
      let currentData = {};
      if (crmDocId) {
        try {
          const snap = await db.collection("solicitudes").doc(crmDocId).get();
          currentData = snap.data() || {};
        } catch {}
      }

      const hasVal = (v) => v !== undefined && v !== null && v !== "" && !(typeof v === "number" && v === 0);
      const keepIfBetter = (existing, incoming) => hasVal(existing) ? existing : incoming;

      // Construimos un update DEFENSIVO:
      //   - fullName/email: si ya hay uno "real" (distinto de "Lead WhatsApp"), lo preservamos.
      //   - numéricos: si el existente ya tiene valor y el entrante es 0, mantenemos el existente.
      //   - strings libres: igual, preservamos el existente si ya tiene valor.
      const placeholderName = (name) => !name || /^lead whatsapp$/i.test(String(name).trim());
      const fullLeadData = {
        // Solo escribimos el placeholder si NO hay nombre real guardado.
        fullName: placeholderName(currentData.fullName) ? "Lead WhatsApp" : currentData.fullName,
        email: keepIfBetter(currentData.email, ""),
        phone: keepIfBetter(currentData.phone, phone),
        loanPurpose: keepIfBetter(currentData.loanPurpose, isRefi ? "refinanciamiento" : "compra"),
        propertyValue: hasVal(currentData.propertyValue) ? currentData.propertyValue : Number(leadData.propertyValue) || 0,
        downPayment:   hasVal(currentData.downPayment)   ? currentData.downPayment   : Number(leadData.downPayment)   || 0,
        monthlyIncome: hasVal(currentData.monthlyIncome) ? currentData.monthlyIncome : Number(leadData.monthlyIncome) || 0,
        creditScore:   keepIfBetter(currentData.creditScore, leadData.creditScore || ""),
        colonia:       keepIfBetter(currentData.colonia,     leadData.colonia     || ""),
        // Origen: solo lo sobreescribimos si no había source (o si venía también de WA).
        source: currentData.source && currentData.source !== "whatsapp_chatbot"
          ? currentData.source
          : "whatsapp_chatbot",
        calificadoEn: currentData.calificadoEn || FieldValue.serverTimestamp(),
        // Campos exclusivos de refinanciamiento (solo si el entrante es refi Y no hay datos previos)
        ...(isRefi && {
          currentBank:    keepIfBetter(currentData.currentBank, leadData.currentBank || ""),
          currentRate:    hasVal(currentData.currentRate)    ? currentData.currentRate    : Number(leadData.currentRate)    || 0,
          currentBalance: hasVal(currentData.currentBalance) ? currentData.currentBalance : Number(leadData.currentBalance) || 0,
        }),
      };
      if (!currentData.estado) fullLeadData.estado = "Recibida";
      // No conservamos la `fecha` original; `serverTimestamp()` sólo se aplica en CREATE abajo.

      if (crmDocId) {
        console.log(`[WH] PASO 5 — merge defensivo sobre lead existente ${crmDocId}. fullName preservado: ${fullLeadData.fullName}`);
        await db.collection("solicitudes").doc(crmDocId).set(fullLeadData, { merge: true });
      } else {
        const docRef = await db.collection("solicitudes").add({
          ...fullLeadData,
          estado: "Recibida",
          fecha: FieldValue.serverTimestamp(),
        });
        crmDocId = docRef.id;
      }
      isNowQualified = true;
      console.log(`[WH] PASO 5 OK — Lead calificado: ${crmDocId}`);
    } catch (e) {
      console.error("[WH] PASO 5 FAIL:", e.code, e.message);
    }
  }

  // ── PASO 5b: Procesar PERFIL_LABORAL ──
  // Si el bot detectó el perfil laboral del prospecto, lo persistimos en la
  // solicitud. Si es PFAE escalamos a asesor humano: pausamos el bot 24h,
  // marcamos `requiereAsesorHumano` y subimos el contador de no-leídos del
  // CRM para que el asesor lo vea en su bandeja con prioridad.
  if (perfilLaboral && crmDocId) {
    try {
      const perfilUpdate = { perfilLaboral };
      if (perfilLaboral === "pfae") {
        perfilUpdate.requiereAsesorHumano = true;
      }
      await db.collection("solicitudes").doc(crmDocId).set(perfilUpdate, { merge: true });
      console.log(`[WH] PASO 5b OK — perfilLaboral="${perfilLaboral}" persistido en lead ${crmDocId}`);

      if (perfilLaboral === "pfae") {
        const pausedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await sessionRef.set({ agentPausedUntil: pausedUntil }, { merge: true });
        await db.collection("solicitudes").doc(crmDocId).set(
          {
            unreadWhatsapp: FieldValue.increment(1),
            agentPausedUntil: pausedUntil,
            requiereAsesorHumano: true,
            escalatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        pfaeEscalated = true;
        console.log(`[WH] PASO 5b — PFAE: bot pausado 24h (hasta ${pausedUntil.toISOString()}), lead escalado a asesor`);
      }
    } catch (e) {
      console.error("[WH] PASO 5b FAIL:", e.code, e.message);
    }
  }

  // Agregar prefijo de acuse si vino media
  let finalReply = reply;
  if (mediaDocs.length > 0) {
    const labels = [...new Set(mediaDocs.map((d) => friendlyClassificationLabel(d.classification)))];
    finalReply = `Recibimos su ${labels.join(" y ")}. ${reply}`;
  }

  // Al calificar POR PRIMERA VEZ vía WhatsApp, enviar enlace para completar
  // expediente. Si el lead ya venía calificado del form web, no re-enviamos
  // el link (ya lo vieron) — el bot se enfoca en pedir documentos.
  if (isNowQualified && !alreadyQualified && crmDocId) {
    const base =
      process.env.PUBLIC_SITE_URL ||
      "https://homeloans.mx";
    const link = `${base.replace(/\/$/, "")}/completar-expediente.html?leadId=${crmDocId}`;
    finalReply += `\n\nPara completar su expediente (ubicación, empresa, pre-cotización de seguro de vida) use este enlace — tarda ~3 min:\n${link}`;
  }

  // ── PASO 6: Persistir sesión ──
  // Usamos arrayUnion para NO destruir los mensajes del agente que
  // hayan podido escribirse en paralelo desde el CRM.
  try {
    const now = new Date().toISOString();
    const newMessages = [];
    if (userMsgForClaude) {
      newMessages.push({ role: "user", content: userMsgForClaude, at: now });
    }
    if (reply) {
      newMessages.push({ role: "assistant", content: reply, at: new Date().toISOString() });
    }

    const sessionUpdate = {
      lastActivity: FieldValue.serverTimestamp(),
      lastInboundAt: FieldValue.serverTimestamp(),
      qualified: isNowQualified || alreadyQualified,
      phone: fromNumber,
      ...(crmDocId && { crmDocId }),
    };
    if (newMessages.length > 0) {
      sessionUpdate.messages = FieldValue.arrayUnion(...newMessages);
    }
    if (incomingMessage) {
      sessionUpdate.unreadCount = FieldValue.increment(1);
    }

    // Si el historial ya supera 2x MAX_HISTORY lo "re-compactamos" a MAX_HISTORY.
    // Leemos de nuevo para obtener los mensajes del agente que pudieron llegar.
    const freshSnap = await sessionRef.get();
    const currentMsgs = freshSnap.exists ? (freshSnap.data().messages || []) : [];
    if (currentMsgs.length + newMessages.length > MAX_HISTORY * 2) {
      const combined = [...currentMsgs, ...newMessages].slice(-MAX_HISTORY);
      sessionUpdate.messages = combined; // reemplazo controlado
    }

    await sessionRef.set(sessionUpdate, { merge: true });
    console.log(`[WH] PASO 6 OK — Sesión guardada (+${newMessages.length} msgs nuevos)`);
  } catch (e) {
    console.error("[WH] PASO 6 FAIL:", e.code, e.message);
  }

  // Actualizar contador de mensajes no leídos en el lead (para el CRM)
  if (crmDocId && incomingMessage) {
    try {
      await db.collection("solicitudes").doc(crmDocId).set(
        {
          unreadWhatsapp: FieldValue.increment(1),
          lastInboundAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch {}
  }

  return sendTwiML(res, finalReply);
}
