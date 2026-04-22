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
  const sessionRef = db.collection("whatsapp_sessions").doc(phoneToDocId(fromNumber));

  try {
    const snap = await sessionRef.get();
    if (snap.exists) {
      const d = snap.data();
      messages = (d.messages || []).filter(
        (m) => m && m.role && (m.role === "user" || m.role === "assistant")
      );
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

  // ── PASO 1b: Primer mensaje — crear lead inicial ──
  const isFirstMessage = messages.length === 0 && !crmDocId;
  if (isFirstMessage) {
    try {
      const phone = fromNumber.replace("whatsapp:", "").replace("+", "");
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
        await db
          .collection("solicitudes")
          .doc(crmDocId)
          .set(
            {
              documentos: FieldValue.arrayUnion(...mediaDocs),
              lastDocumentAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
      } catch (e) {
        console.error("[WH] PASO 2 persist FAIL:", e.code, e.message);
      }
    }
  }

  // ── PASO 3: Decidir respuesta ──
  // Si el bot está pausado (agente tomó control), solo registramos el mensaje sin responder via Claude.
  if (botPaused) {
    if (incomingMessage) {
      messages.push({ role: "user", content: incomingMessage });
    }
    try {
      await sessionRef.set(
        {
          messages: messages.slice(-MAX_HISTORY),
          lastActivity: FieldValue.serverTimestamp(),
          phone: fromNumber,
          ...(crmDocId && { crmDocId }),
        },
        { merge: true }
      );
    } catch (e) {
      console.error("[WH] paused session write FAIL:", e.message);
    }
    console.log("[WH] Bot pausado — sin respuesta automática");
    // Si llegaron docs, igual mandamos un acuse corto
    if (mediaDocs.length > 0) {
      const labels = [...new Set(mediaDocs.map((d) => friendlyClassificationLabel(d.classification)))];
      return sendTwiML(res, `Recibimos su ${labels.join(" y ")}, gracias. Un asesor le responderá pronto.`);
    }
    return sendTwiML(res, "");
  }

  // Lead ya calificado y sin media nueva: respuesta estática + link de expediente si falta.
  if (alreadyQualified && mediaDocs.length === 0) {
    // Revisar si el expediente ya está completo
    let expedienteDone = false;
    if (crmDocId) {
      try {
        const leadSnap = await db.collection("solicitudes").doc(crmDocId).get();
        const data = leadSnap.data() || {};
        expedienteDone = !!data.expedienteProgreso?.completado;
      } catch (e) {
        console.error("[WH] no se pudo leer expedienteProgreso:", e.message);
      }
    }

    let reply;
    if (!expedienteDone && crmDocId) {
      const base = (process.env.PUBLIC_SITE_URL || "https://homeloans.mx").replace(/\/$/, "");
      const link = `${base}/completar-expediente.html?leadId=${crmDocId}`;
      reply =
        `Gracias, ya tenemos su pre-calificación. Para avanzar con el banco falta completar su expediente (empresa, ubicación, referencias y pre-cotización de seguro de vida) — tarda ~3 minutos:\n\n${link}\n\n` +
        `Si tiene alguna duda, escríbala aquí y un asesor le responderá a la brevedad.`;
    } else {
      reply =
        "Gracias, su expediente está completo. Un asesor de HomeLoans.mx le contactará en las próximas 24 horas. ¿Tiene alguna pregunta adicional?";
    }
    return sendTwiML(res, reply);
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

  let rawReply;
  try {
    const claudeResponse = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: SYSTEM_PROMPT,
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
        calificadoEn: FieldValue.serverTimestamp(),
      };

      if (crmDocId) {
        await db.collection("solicitudes").doc(crmDocId).set(fullLeadData, { merge: true });
      } else {
        const docRef = await db.collection("solicitudes").add({
          ...fullLeadData,
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
  try {
    messages.push({ role: "assistant", content: reply });
    const trimmed = messages.slice(-MAX_HISTORY);
    await sessionRef.set(
      {
        messages: trimmed,
        lastActivity: FieldValue.serverTimestamp(),
        qualified: isNowQualified || alreadyQualified,
        phone: fromNumber,
        ...(crmDocId && { crmDocId }),
      },
      { merge: true }
    );
    console.log(`[WH] PASO 6 OK — Sesión guardada (${trimmed.length} msgs)`);
  } catch (e) {
    console.error("[WH] PASO 6 FAIL:", e.code, e.message);
  }

  return sendTwiML(res, finalReply);
}
