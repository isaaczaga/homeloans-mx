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
const CLASSIFY_PROMPT = `Analiza este documento mexicano relacionado con un trámite hipotecario. Clasifícalo en una de estas categorías:
- "INE" (credencial de elector)
- "comprobante_ingresos" (recibo de nómina, carta patronal, constancia de sueldo)
- "estado_cuenta" (bancario, de inversión, de afore)
- "comprobante_domicilio" (CFE, Telmex, predial, agua)
- "escritura" (escritura pública de propiedad)
- "identificacion_otra" (pasaporte, cédula profesional)
- "rfc" (constancia de situación fiscal)
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
// Lista canónica de documentos que componen el expediente hipotecario.
// Cada item tiene las `classifications` que cuentan como "recibido" si el
// bot las subió vía el classifier de Claude.
const REQUIRED_DOCS = [
  { key: "INE",                  label: "INE vigente (ambos lados)",                classifications: ["INE", "identificacion_otra"] },
  { key: "comprobante_ingresos", label: "Últimos 3 recibos de nómina o carta patronal", classifications: ["comprobante_ingresos"] },
  { key: "estado_cuenta",        label: "Últimos 3 estados de cuenta bancarios",    classifications: ["estado_cuenta"] },
  { key: "comprobante_domicilio",label: "Comprobante de domicilio reciente (CFE, Telmex, agua o predial)", classifications: ["comprobante_domicilio"] },
  { key: "rfc",                  label: "Constancia de situación fiscal (CSF / RFC)", classifications: ["rfc"] },
];

// Devuelve un resumen breve en español de los datos que ya tenemos en la
// solicitud y la lista de documentos que aún faltan. Usado para inyectar
// contexto al system prompt de Claude y evitar que pregunte datos ya dados.
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

  // Documentos ya recibidos
  const docsArr = Array.isArray(leadData.documentos) ? leadData.documentos : [];
  const receivedClassifications = new Set(
    docsArr.map((d) => d?.classification).filter(Boolean)
  );

  const received = [];
  const missing = [];
  for (const req of REQUIRED_DOCS) {
    const hit = req.classifications.some((c) => receivedClassifications.has(c));
    (hit ? received : missing).push(req.label);
  }

  // Para refinanciamiento también pedimos la escritura
  if (leadData.loanPurpose === "refinanciamiento") {
    const hasEscritura = receivedClassifications.has("escritura");
    (hasEscritura ? received : missing).push("Escritura pública de la propiedad");
  }

  return {
    summary: lines.join("\n"),
    received,
    missing,
    isComplete: missing.length === 0,
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
    comprobante_ingresos: "comprobante de ingresos",
    estado_cuenta: "estado de cuenta",
    comprobante_domicilio: "comprobante de domicilio",
    escritura: "escritura",
    identificacion_otra: "identificación",
    rfc: "RFC",
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

  // ── PASO 1b: Primer mensaje — crear lead inicial o enlazar ──
  const isFirstMessage = messages.length === 0 && !crmDocId;
  if (isFirstMessage) {
    try {
      const digits = fromNumber.replace(/\D/g, "");
      const tenDigitPhone = digits.length >= 10 ? digits.slice(-10) : digits;
      
      const leadsRef = db.collection("solicitudes");
      let existingLeadSnap = await leadsRef.where("phone", "==", digits).limit(1).get();
      if (existingLeadSnap.empty && tenDigitPhone !== digits) {
        existingLeadSnap = await leadsRef.where("phone", "==", tenDigitPhone).limit(1).get();
      }

      if (!existingLeadSnap.empty) {
        crmDocId = existingLeadSnap.docs[0].id;
        console.log(`[WH] PASO 1b OK — Lead existente encontrado: ${crmDocId}`);
      } else {
        const phone = digits;
        const docRef = await db.collection("solicitudes").add({
          fullName: "Lead WhatsApp",
          phone,
          primerMensaje: incomingMessage || "(adjunto archivo)",
          source: "whatsapp_chatbot",
          estado: "Recibida",
          fecha: FieldValue.serverTimestamp(),
        });
        crmDocId = docRef.id;
        console.log(`[WH] PASO 1b OK — Lead inicial creado: ${crmDocId}`);
      }
    } catch (e) {
      console.error("[WH] PASO 1b FAIL:", e.code, e.message);
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

    const docsBlock = solicitudCtx
      ? (solicitudCtx.isComplete
          ? `EXPEDIENTE DE DOCUMENTOS: COMPLETO. Ya recibimos todos los documentos requeridos. Si el cliente pregunta qué sigue, dile que el asesor está revisando su expediente y lo contactará en las próximas 24h.`
          : `EXPEDIENTE DE DOCUMENTOS — PENDIENTE.
Ya recibidos: ${solicitudCtx.received.length ? solicitudCtx.received.join("; ") : "ninguno todavía"}.
Faltan: ${solicitudCtx.missing.join("; ")}.

TU OBJETIVO ES RECOLECTAR LOS DOCUMENTOS FALTANTES.
- Si es el primer mensaje del día, saluda por su nombre (si lo tienes) y confirma que ya vimos su solicitud.
- Luego pide UN documento a la vez, de forma conversacional y amable. Empieza por el primero de "Faltan".
- Si el cliente envió un archivo, confírmale que lo recibiste e indica cuál es el siguiente documento pendiente.
- Acepta PDF, JPG o PNG. Si la foto sale borrosa o cortada, pídela de nuevo amablemente.
- Para INE, pide explícitamente AMBOS LADOS (frente y reverso).`)
      : "";

    dynamicSystemPrompt = `Eres Isaac, asesor hipotecario senior de HomeLoans.mx. El prospecto YA completó su solicitud de pre-calificación.

${datosBlock}

REGLAS GENERALES:
- NUNCA vuelvas a preguntar propósito del crédito, valor de la propiedad, enganche, ingreso ni historial crediticio. Ya los tenemos.
- Sé profesional, amable y MUY conciso (1-2 oraciones máximo).
- Responde SIEMPRE en español.
- TASAS: si pregunta, di que arrancan desde 8.95% anual; un rango exacto requiere validar el expediente completo. Nunca menciones porcentajes menores a 8.95%.
- Máxima edad + plazo = 80 años. Si aplica, avisar amablemente.

${docsBlock}`;
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

  // ── PASO 5: Procesar LEAD_DATA ──
  const { cleanText: reply, leadData } = extractLeadData(rawReply);
  let isNowQualified = false;

  if (leadData) {
    try {
      const phone = fromNumber.replace("whatsapp:", "").replace("+", "");
      const isRefi = leadData.loanPurpose === "refinanciamiento";
      const fullLeadData = {
        fullName: "Lead WhatsApp",
        phone,
        loanPurpose: isRefi ? "refinanciamiento" : "compra",
        propertyValue: Number(leadData.propertyValue) || 0,
        downPayment: Number(leadData.downPayment) || 0,
        monthlyIncome: Number(leadData.monthlyIncome) || 0,
        creditScore: leadData.creditScore || "",
        colonia: leadData.colonia || "",
        source: "whatsapp_chatbot",
        calificadoEn: FieldValue.serverTimestamp(),
        // Campos exclusivos de refinanciamiento
        ...(isRefi && {
          currentBank: leadData.currentBank || "",
          currentRate: Number(leadData.currentRate) || 0,
          currentBalance: Number(leadData.currentBalance) || 0,
        }),
      };

      if (crmDocId) {
        // Obtenemos el estado actual para no sobreescribirlo si ya avanzó
        const leadSnapForUpdate = await db.collection("solicitudes").doc(crmDocId).get();
        const currentData = leadSnapForUpdate.data() || {};
        if (!currentData.estado) fullLeadData.estado = "Recibida";
        
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

  // Agregar prefijo de acuse si vino media
  let finalReply = reply;
  if (mediaDocs.length > 0) {
    const labels = [...new Set(mediaDocs.map((d) => friendlyClassificationLabel(d.classification)))];
    finalReply = `Recibimos su ${labels.join(" y ")}. ${reply}`;
  }

  // Al calificar (primera vez), enviar enlace para completar expediente.
  // Usamos crmDocId (el Firestore doc ID, 20 chars, no guessable) como token del enlace.
  if (isNowQualified && crmDocId) {
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
