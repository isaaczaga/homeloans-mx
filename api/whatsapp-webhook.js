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
  const fbApp = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  db = getFirestore(fbApp);
  console.log("[WH] Firebase OK — project:", process.env.FIREBASE_PROJECT_ID);
} catch (e) {
  console.error("[WH] Firebase INIT ERROR:", e.message);
}

// ── Anthropic ───────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── TwiML helper (compatible con ESM + Twilio v5) ──────────
function buildTwiML(message) {
  // Acceso robusto a MessagingResponse en ESM
  const MR =
    twilio?.twiml?.MessagingResponse ||
    twilio?.default?.twiml?.MessagingResponse;
  if (MR) {
    const r = new MR();
    r.message(message);
    return r.toString();
  }
  // Fallback manual si el import de twiml falla
  const safe = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
}

function sendTwiML(res, message) {
  const xml = buildTwiML(message);
  res.setHeader("Content-Type", "text/xml");
  return res.status(200).send(xml);
}

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

Solo incluye LEAD_DATA cuando tengas los 5 valores confirmados.`;

const MAX_HISTORY = 20;

// ── Utilidades ──────────────────────────────────────────────

function phoneToDocId(phone) {
  return "wa_" + phone.replace(/\W/g, "_");
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

// ── Handler principal ────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const body = parseBody(req);
  const incomingMessage = (body.Body || "").trim();
  const fromNumber = body.From || "";

  console.log(`[WH] ▶ De: ${fromNumber} | Msg: "${incomingMessage}"`);

  if (!incomingMessage || !fromNumber) {
    console.error("[WH] Body vacío — From:", fromNumber, "Body:", body.Body);
    return res.status(400).send("Bad Request");
  }

  if (!db) {
    console.error("[WH] Firestore no inicializado — revisa variables FIREBASE_*");
    return sendTwiML(res, "Lo sentimos, hay un problema técnico. Intente más tarde.");
  }

  // ── PASO 1: Leer sesión de Firestore ──
  let messages = [];
  let alreadyQualified = false;
  let crmDocId = null; // ID del documento en "solicitudes" para este lead
  const sessionRef = doc(db, "whatsapp_sessions", phoneToDocId(fromNumber));

  try {
    const sessionSnap = await getDoc(sessionRef);
    if (sessionSnap.exists()) {
      const d = sessionSnap.data();
      messages = d.messages || [];
      alreadyQualified = d.qualified || false;
      crmDocId = d.crmDocId || null;
    }
    console.log(`[WH] PASO 1 OK — historial: ${messages.length} msgs, calificado: ${alreadyQualified}, crmDocId: ${crmDocId}`);
  } catch (e) {
    console.error("[WH] PASO 1 FAIL — Firestore read:", e.code, e.message);
    return sendTwiML(res, "Disculpe, tuvimos un problema al leer su sesión. Intente de nuevo.");
  }

  // Lead ya calificado
  if (alreadyQualified) {
    const reply = "Gracias, ya tenemos su información. Un asesor de HomeLoans.mx le contactará en las próximas 24 horas. ¿Tiene alguna pregunta adicional?";
    console.log("[WH] Lead ya calificado — respuesta directa");
    return sendTwiML(res, reply);
  }

  // ── PASO 1b: Primer mensaje — crear lead inicial en solicitudes ──
  const isFirstMessage = messages.length === 0;
  if (isFirstMessage && !crmDocId) {
    try {
      const phone = fromNumber.replace("whatsapp:", "").replace("+", "");
      const docRef = await addDoc(collection(db, "solicitudes"), {
        fullName: "Lead WhatsApp",
        phone,
        primerMensaje: incomingMessage,
        source: "whatsapp_chatbot",
        estado: "Recibida",
        fecha: serverTimestamp(),
      });
      crmDocId = docRef.id;
      console.log(`[WH] PASO 1b OK — Lead inicial creado en solicitudes: ${crmDocId}`);
    } catch (e) {
      console.error("[WH] PASO 1b FAIL — Firestore create solicitud:", e.code, e.message);
      // No bloquear — continuar de todas formas
    }
  }

  // ── PASO 2: Llamar a Claude ──
  messages.push({ role: "user", content: incomingMessage });
  let rawReply;
  try {
    const claudeResponse = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: messages.slice(-MAX_HISTORY),
    });
    rawReply = claudeResponse.content?.[0]?.text || "Un momento, por favor.";
    console.log(`[WH] PASO 2 OK — Claude respondió (${rawReply.length} chars)`);
  } catch (e) {
    console.error("[WH] PASO 2 FAIL — Claude API:", e.status, e.message);
    return sendTwiML(res, "Disculpe, el asistente no está disponible en este momento. Intente en unos minutos.");
  }

  // ── PASO 3: Procesar respuesta y actualizar lead si está calificado ──
  const { cleanText: reply, leadData } = extractLeadData(rawReply);
  let isNowQualified = false;

  if (leadData) {
    try {
      const phone = fromNumber.replace("whatsapp:", "").replace("+", "");
      const fullLeadData = {
        fullName: "Lead WhatsApp",
        phone,
        loanPurpose: "compra",
        propertyValue: Number(leadData.propertyValue) || 0,
        downPayment: Number(leadData.downPayment) || 0,
        monthlyIncome: Number(leadData.monthlyIncome) || 0,
        creditScore: leadData.creditScore || "",
        colonia: leadData.colonia || "",
        source: "whatsapp_chatbot",
        estado: "Recibida",
        calificadoEn: serverTimestamp(),
      };

      if (crmDocId) {
        // Actualizar el documento ya existente
        await setDoc(doc(db, "solicitudes", crmDocId), fullLeadData, { merge: true });
        console.log(`[WH] PASO 3 OK — Lead actualizado en solicitudes: ${crmDocId}`);
      } else {
        // Fallback: crear nuevo si no existe el doc inicial
        const docRef = await addDoc(collection(db, "solicitudes"), {
          ...fullLeadData,
          fecha: serverTimestamp(),
        });
        crmDocId = docRef.id;
        console.log(`[WH] PASO 3 OK — Lead nuevo creado en solicitudes: ${crmDocId}`);
      }
      isNowQualified = true;
    } catch (e) {
      console.error("[WH] PASO 3 FAIL — Firestore update solicitudes:", e.code, e.message);
    }
  }

  // ── PASO 4: Actualizar sesión en Firestore ──
  try {
    messages.push({ role: "assistant", content: reply });
    const trimmed = messages.slice(-MAX_HISTORY);
    await setDoc(sessionRef, {
      messages: trimmed,
      lastActivity: serverTimestamp(),
      qualified: isNowQualified,
      phone: fromNumber,
      ...(crmDocId && { crmDocId }),
    }, { merge: true });
    console.log(`[WH] PASO 4 OK — Sesión actualizada (${trimmed.length} msgs)`);
  } catch (e) {
    console.error("[WH] PASO 4 FAIL — Firestore write sesión:", e.code, e.message);
  }

  // ── PASO 5: Responder vía TwiML ──
  console.log(`[WH] PASO 5 — Enviando TwiML: "${reply.slice(0, 60)}..."`);
  return sendTwiML(res, reply);
}
