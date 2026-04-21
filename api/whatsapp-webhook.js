/**
 * /api/whatsapp-webhook.js
 * Chatbot de WhatsApp para HomeLoans.mx
 * Twilio → Claude (Isaac) → Firestore → Twilio
 */

import Anthropic from "@anthropic-ai/sdk";
import twilio from "twilio";
import { initializeApp, getApps } from "firebase/app";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  addDoc,
  collection,
  serverTimestamp,
} from "firebase/firestore";

// ── Firebase ────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
};

let db;
try {
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  db = getFirestore(app);
} catch (e) {
  console.error("Firebase init error:", e.message);
}

// ── Anthropic ───────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Twilio ──────────────────────────────────────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── Sistema prompt de Isaac ─────────────────────────────────
const SYSTEM_PROMPT = `Eres Isaac, asesor hipotecario senior de HomeLoans.mx en CDMX. Te especializas en propiedades de $10M+ MXN en zonas premium: Polanco, Lomas de Chapultepec, Bosques de las Lomas, Lomas de Vistahermosa, Interlomas, Santa Fe y Pedregal.

Tu misión es calificar prospectos haciendo estas 5 preguntas de forma conversacional, una a la vez (nunca todas juntas):
1. Valor aproximado de la propiedad que busca
2. Colonia o zona de interés
3. Enganche disponible (monto en pesos)
4. Ingresos mensuales comprobables
5. Historial crediticio (Excelente / Bueno / Regular / Sin historial)

Reglas estrictas:
- Sé profesional, amable y MUY conciso. Máximo 2-3 oraciones por respuesta.
- Responde SIEMPRE en español.
- No menciones tasas de interés específicas hasta tener el perfil completo.
- Si el prospecto pregunta algo fuera de tema, redirige amablemente hacia la calificación.
- Cuando tengas los 5 datos, agradece y dile que un asesor lo contactará en menos de 24 horas.

INSTRUCCIÓN ESPECIAL — cuando hayas recopilado los 5 datos, incluye AL FINAL de tu respuesta, en una línea separada, el siguiente bloque (el usuario nunca lo verá):
LEAD_DATA:{"propertyValue":NUMERO_SIN_COMAS,"colonia":"TEXTO","downPayment":NUMERO_SIN_COMAS,"monthlyIncome":NUMERO_SIN_COMAS,"creditScore":"TEXTO"}

Solo incluye LEAD_DATA cuando tengas todos los 5 valores confirmados.`;

// ── Constantes ──────────────────────────────────────────────
const MAX_HISTORY = 20; // mensajes máximos en memoria por sesión

// ── Utilidades ──────────────────────────────────────────────

/** Convierte el número de WhatsApp a un ID de documento válido para Firestore */
function phoneToDocId(phone) {
  return "wa_" + phone.replace(/\W/g, "_");
}

/** Parsea el body de la request (JSON o form-encoded) */
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

/** Extrae y elimina el bloque LEAD_DATA del texto de Claude */
function extractLeadData(text) {
  const marker = "LEAD_DATA:";
  const idx = text.indexOf(marker);
  if (idx === -1) return { cleanText: text.trim(), leadData: null };

  const cleanText = text.slice(0, idx).trim();
  try {
    const json = text.slice(idx + marker.length).trim();
    const leadData = JSON.parse(json);
    return { cleanText, leadData };
  } catch {
    return { cleanText, leadData: null };
  }
}

// ── Handler principal ────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  // Validar firma de Twilio (recomendado en producción)
  if (process.env.VALIDATE_TWILIO_SIGNATURE === "true") {
    const signature = req.headers["x-twilio-signature"] || "";
    const url = `https://${req.headers.host}/api/whatsapp-webhook`;
    const body = parseBody(req);
    const isValid = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      signature,
      url,
      body
    );
    if (!isValid) {
      console.warn("Twilio signature validation failed");
      return res.status(403).send("Forbidden");
    }
  }

  const body = parseBody(req);
  const incomingMessage = (body.Body || "").trim();
  const fromNumber = body.From || ""; // ej: whatsapp:+521234567890
  const toNumber = body.To || process.env.TWILIO_WHATSAPP_NUMBER;

  if (!incomingMessage || !fromNumber) {
    return res.status(400).send("Bad Request");
  }

  console.log(`[WhatsApp] Mensaje de ${fromNumber}: "${incomingMessage}"`);

  if (!db) {
    return sendTwiML(res, "Lo sentimos, hay un problema técnico. Intente más tarde.");
  }

  try {
    // 1. Leer sesión existente desde Firestore
    const sessionRef = doc(db, "whatsapp_sessions", phoneToDocId(fromNumber));
    const sessionSnap = await getDoc(sessionRef);
    let messages = [];
    let alreadyQualified = false;

    if (sessionSnap.exists()) {
      const data = sessionSnap.data();
      messages = data.messages || [];
      alreadyQualified = data.qualified || false;
    }

    // Si ya fue calificado, responder brevemente
    if (alreadyQualified) {
      const reply =
        "Gracias, ya tenemos su información. Un asesor de HomeLoans.mx le contactará en las próximas 24 horas. ¿Tiene alguna pregunta adicional?";
      await updateSession(sessionRef, messages, incomingMessage, reply, false);
      return sendTwiML(res, reply);
    }

    // 2. Agregar mensaje del usuario al historial
    messages.push({ role: "user", content: incomingMessage });

    // 3. Llamar a Claude
    const claudeResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: messages.slice(-MAX_HISTORY),
    });

    const rawReply =
      claudeResponse.content?.[0]?.text || "Un momento, por favor.";

    // 4. Extraer LEAD_DATA si Claude la incluyó
    const { cleanText: reply, leadData } = extractLeadData(rawReply);

    // 5. Si hay lead data, guardar en solicitudes (CRM)
    let isNowQualified = false;
    if (leadData) {
      isNowQualified = true;
      await saveLead(leadData, fromNumber);
      console.log(`[WhatsApp] Lead calificado guardado para ${fromNumber}`);
    }

    // 6. Actualizar historial de sesión en Firestore
    messages.push({ role: "assistant", content: reply });
    await updateSession(sessionRef, messages, null, null, isNowQualified);

    // 7. Responder al usuario vía TwiML
    return sendTwiML(res, reply);
  } catch (error) {
    console.error("[WhatsApp] Error en handler:", error);
    return sendTwiML(
      res,
      "Disculpe, tuvimos un problema. Por favor intente de nuevo en un momento."
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────

/** Envía respuesta TwiML a Twilio (Twilio la entrega como mensaje de WhatsApp) */
function sendTwiML(res, message) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(message);
  res.setHeader("Content-Type", "text/xml");
  return res.status(200).send(twiml.toString());
}

/** Actualiza el documento de sesión en Firestore */
async function updateSession(
  sessionRef,
  messages,
  userMsg,
  assistantMsg,
  qualified
) {
  // Si se pasan mensajes nuevos sueltos (para el caso del ya-calificado)
  const history = [...messages];
  if (userMsg) history.push({ role: "user", content: userMsg });
  if (assistantMsg) history.push({ role: "assistant", content: assistantMsg });

  // Mantener solo los últimos MAX_HISTORY mensajes
  const trimmed = history.slice(-MAX_HISTORY);

  await setDoc(
    sessionRef,
    {
      messages: trimmed,
      lastActivity: serverTimestamp(),
      ...(qualified !== null && { qualified }),
    },
    { merge: true }
  );
}

/** Guarda el lead calificado en la colección solicitudes (misma que usa el CRM) */
async function saveLead(leadData, fromNumber) {
  const phone = fromNumber.replace("whatsapp:", "").replace("+", "");
  await addDoc(collection(db, "solicitudes"), {
    fullName: "Lead WhatsApp",
    phone: phone,
    loanPurpose: "compra",
    propertyValue: Number(leadData.propertyValue) || 0,
    downPayment: Number(leadData.downPayment) || 0,
    monthlyIncome: Number(leadData.monthlyIncome) || 0,
    creditScore: leadData.creditScore || "",
    colonia: leadData.colonia || "",
    source: "whatsapp_chatbot",
    estado: "Recibida",
    fecha: serverTimestamp(),
  });
}
