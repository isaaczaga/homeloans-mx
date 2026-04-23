/**
 * /api/backfill-docs.js
 * Recupera documentos huérfanos de WhatsApp que quedaron en Storage pero
 * nunca se asociaron a un lead en Firestore.
 *
 * ¿Por qué existe este endpoint?
 * En versiones anteriores del webhook, si el chat de WhatsApp no estaba
 * vinculado a una `solicitudes/{id}` (porque el matching por teléfono falló
 * o no se ejecutó fuera del primer mensaje), los archivos del cliente se
 * subían a Storage en `leads/unclaimed/<timestamp>_<idx>.<ext>` y nunca se
 * escribían en `solicitudes.documentos`. Este endpoint escanea esa carpeta
 * y los reasocia al lead correcto cruzando el timestamp del archivo contra
 * los mensajes del cliente en `whatsapp_sessions`.
 *
 * Uso:
 *   POST /api/backfill-docs
 *   Authorization: Bearer <firebase ID token>
 *   Body: { dryRun?: boolean, maxFiles?: number }
 *
 * Respuesta:
 *   {
 *     ok: true,
 *     scanned: 12,
 *     matched: 8,
 *     reassigned: 8,
 *     unmatched: [ { storagePath, timestamp, reason } ... ],
 *     errors: [ ... ],
 *     remaining: 4,     // Archivos aún en unclaimed después de este batch
 *   }
 *
 * Si `remaining > 0` se puede volver a llamar al endpoint para procesar
 * el siguiente batch (Vercel hobby tiene timeout de 10s; cada archivo
 * toma ~2-5s por la clasificación via Claude Vision).
 */

import Anthropic from "@anthropic-ai/sdk";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { getAuth } from "firebase-admin/auth";

// ── Firebase Admin ──────────────────────────────────────────
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
} catch (e) {
  console.error("[BACKFILL] Firebase Admin INIT ERROR:", e.message);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

// ── Helpers ─────────────────────────────────────────────────

// Extrae el timestamp (ms epoch) y el índice desde un nombre tipo
// "1713500000000_0.pdf". Devuelve null si el formato no matchea.
function parseUnclaimedFilename(path) {
  // path = "leads/unclaimed/1713500000000_0.pdf"
  const base = path.split("/").pop() || "";
  const m = base.match(/^(\d{10,16})_(\d+)\.([a-z0-9]+)$/i);
  if (!m) return null;
  return { timestamp: Number(m[1]), index: Number(m[2]), ext: m[3].toLowerCase() };
}

function extToMime(ext) {
  const m = String(ext || "").toLowerCase();
  if (m === "jpg" || m === "jpeg") return "image/jpeg";
  if (m === "png") return "image/png";
  if (m === "webp") return "image/webp";
  if (m === "heic") return "image/heic";
  if (m === "pdf") return "application/pdf";
  if (m === "mp4") return "video/mp4";
  return "application/octet-stream";
}

async function classifyBuffer(buffer, mimeType) {
  const isImage = mimeType.startsWith("image/");
  const isPdf = mimeType === "application/pdf";
  if (!isImage && !isPdf) {
    return { classification: "otro", summary: "Archivo no clasificable" };
  }
  const base64 = buffer.toString("base64");
  const content = [
    {
      type: isPdf ? "document" : "image",
      source: { type: "base64", media_type: mimeType, data: base64 },
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
    const jsonMatch = text.match(/\{[^{}]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    return {
      classification: parsed.classification || "otro",
      summary: parsed.summary || "",
    };
  } catch (e) {
    console.error("[BACKFILL] classify fail:", e.message);
    return { classification: "otro", summary: "No se pudo clasificar" };
  }
}

// Busca la sesión de WhatsApp cuyo mensaje "user" esté más cerca (±90s)
// del timestamp del archivo. Devuelve { sessionId, crmDocId, phone } o null.
async function findSessionByTimestamp(fileTs, sessionCache) {
  const WINDOW_MS = 90 * 1000;
  let best = null;
  let bestDelta = Infinity;
  for (const s of sessionCache) {
    for (const m of s.messages) {
      if (m.role !== "user" || !m.at) continue;
      const msgTs = Date.parse(m.at);
      if (!Number.isFinite(msgTs)) continue;
      const delta = Math.abs(msgTs - fileTs);
      if (delta < WINDOW_MS && delta < bestDelta) {
        bestDelta = delta;
        best = s;
      }
    }
  }
  return best;
}

// ── Handler ─────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  if (!db || !bucket) {
    return res.status(500).json({ error: "Firebase Admin no inicializado" });
  }

  // Auth (mismo patrón que send-whatsapp)
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) return res.status(401).json({ error: "Missing Authorization: Bearer <idToken>" });
  let agentEmail;
  try {
    const decoded = await getAuth().verifyIdToken(match[1]);
    agentEmail = decoded.email || "unknown";
  } catch (e) {
    return res.status(401).json({ error: `Token inválido: ${e.message}` });
  }

  const body = typeof req.body === "object" ? req.body : {};
  const dryRun = body.dryRun === true;
  const maxFiles = Math.max(1, Math.min(Number(body.maxFiles) || 8, 20));

  console.log(`[BACKFILL] Iniciado por ${agentEmail} | dryRun=${dryRun} | maxFiles=${maxFiles}`);

  try {
    // 1) Listar archivos en leads/unclaimed/
    const [files] = await bucket.getFiles({ prefix: "leads/unclaimed/" });
    const realFiles = files.filter((f) => !f.name.endsWith("/")); // ignora "directorios"
    console.log(`[BACKFILL] Encontrados ${realFiles.length} archivos en unclaimed/`);

    if (realFiles.length === 0) {
      return res.status(200).json({
        ok: true,
        scanned: 0,
        matched: 0,
        reassigned: 0,
        unmatched: [],
        errors: [],
        remaining: 0,
        message: "No hay archivos en leads/unclaimed/",
      });
    }

    // 2) Pre-cargar todas las sesiones con crmDocId para el cruce por timestamp.
    // Esto evita hacer 1 query por archivo.
    const sessionsSnap = await db.collection("whatsapp_sessions").get();
    const sessionCache = [];
    sessionsSnap.forEach((doc) => {
      const d = doc.data() || {};
      if (!d.crmDocId) return;
      sessionCache.push({
        sessionId: doc.id,
        crmDocId: d.crmDocId,
        phone: d.phone || "",
        messages: Array.isArray(d.messages) ? d.messages : [],
      });
    });
    console.log(`[BACKFILL] ${sessionCache.length} sesiones con crmDocId disponibles para match`);

    const toProcess = realFiles.slice(0, maxFiles);
    const unmatched = [];
    const errors = [];
    let matched = 0;
    let reassigned = 0;

    for (const file of toProcess) {
      try {
        const parsed = parseUnclaimedFilename(file.name);
        if (!parsed) {
          unmatched.push({ storagePath: file.name, reason: "nombre no parseable" });
          continue;
        }

        const session = await findSessionByTimestamp(parsed.timestamp, sessionCache);
        if (!session) {
          unmatched.push({
            storagePath: file.name,
            timestamp: new Date(parsed.timestamp).toISOString(),
            reason: "sin mensaje de cliente cercano (±90s)",
          });
          continue;
        }
        matched++;

        if (dryRun) {
          console.log(`[BACKFILL DRY-RUN] ${file.name} → lead ${session.crmDocId}`);
          continue;
        }

        // 3) Descargar bytes, clasificar
        const [buffer] = await file.download();
        const [metadata] = await file.getMetadata();
        const mimeType = metadata.contentType || extToMime(parsed.ext);
        const { classification, summary } = await classifyBuffer(buffer, mimeType);

        // 4) Copiar a leads/{crmDocId}/ (misma timestamp+index pero bajo la ruta correcta)
        const newPath = `leads/${session.crmDocId}/${parsed.timestamp}_${parsed.index}.${parsed.ext}`;
        await file.copy(bucket.file(newPath));
        const newFile = bucket.file(newPath);
        const [signedUrl] = await newFile.getSignedUrl({
          action: "read",
          expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
        });

        // 5) Agregar al array `documentos` del lead
        const docEntry = {
          url: signedUrl,
          storagePath: newPath,
          mimeType,
          classification,
          summary,
          filename: `whatsapp_${parsed.timestamp}_${parsed.index}.${parsed.ext}`,
          uploadedAt: new Date(parsed.timestamp).toISOString(),
          source: "whatsapp",
          backfilledAt: new Date().toISOString(),
          backfilledBy: agentEmail,
        };
        await db.collection("solicitudes").doc(session.crmDocId).set(
          {
            documentos: FieldValue.arrayUnion(docEntry),
            lastDocumentAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        // 6) Borrar el archivo huérfano original (ya fue copiado)
        await file.delete();

        reassigned++;
        console.log(`[BACKFILL] ✓ ${file.name} → lead ${session.crmDocId} (${classification})`);
      } catch (e) {
        console.error(`[BACKFILL] error procesando ${file.name}:`, e.message);
        errors.push({ storagePath: file.name, error: e.message });
      }
    }

    const remaining = realFiles.length - toProcess.length;
    return res.status(200).json({
      ok: true,
      scanned: toProcess.length,
      matched,
      reassigned,
      unmatched,
      errors,
      remaining,
      dryRun,
    });
  } catch (e) {
    console.error("[BACKFILL] fatal:", e.message, e.stack);
    return res.status(500).json({ error: e.message });
  }
}
