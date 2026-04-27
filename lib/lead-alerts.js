/**
 * lib/lead-alerts.js
 * Scoring de leads + notificación por WhatsApp al agente cuando un lead
 * supera el umbral de calidad. Se importa desde:
 *   - /api/enviar-calificacion.js (al crear/actualizar lead desde el form)
 *   - /api/guardar-expediente.js  (al completar el expediente)
 *
 * Idempotencia: se marca `agentAlertedAt` en el doc del lead para evitar
 * múltiples avisos del mismo prospecto.
 *
 * Configuración (Vercel env vars):
 *   AGENT_NOTIFICATION_PHONE     — número de WhatsApp del agente (ej. 525519481494)
 *   AGENT_ALERT_SCORE_THRESHOLD  — umbral 0–10 (default 7)
 */

import { FieldValue } from "firebase-admin/firestore";

const DEFAULT_THRESHOLD = 7;

/**
 * Heurística de calidad del lead. Devuelve 0–10.
 *  Ingreso (0–3): 30k+ → 1, 50k+ → 2, 80k+ → 3
 *  Crédito (0–3): Regular → 1, Bueno → 2, Excelente → 3
 *  Enganche (0–2): 20%+ → 1, 30%+ → 2 (compra) | refi → 1 base
 *  Capacidad (0–2): préstamo / ingreso ≤ 144 meses → 1, ≤ 84 meses → 2
 *  Bonus expediente completado: +1
 */
export function scoreLead(lead) {
  if (!lead) return 0;
  let score = 0;

  const income = Number(lead.monthlyIncome) || 0;
  if (income >= 80000) score += 3;
  else if (income >= 50000) score += 2;
  else if (income >= 30000) score += 1;

  const credit = String(lead.creditScore || "").toLowerCase();
  if (credit.includes("excelente")) score += 3;
  else if (credit.includes("bueno")) score += 2;
  else if (credit.includes("regular")) score += 1;

  const propertyValue = Number(lead.propertyValue) || 0;
  const downPayment = Number(lead.downPayment) || 0;
  if (lead.loanPurpose === "compra" && propertyValue > 0) {
    const ratio = downPayment / propertyValue;
    if (ratio >= 0.30) score += 2;
    else if (ratio >= 0.20) score += 1;
  } else if (lead.loanPurpose === "refinanciamiento") {
    score += 1;
  }

  // Capacidad de pago aproximada: cuántos meses de ingreso = monto del préstamo
  const loanAmount =
    lead.loanPurpose === "refinanciamiento"
      ? Number(lead.currentBalance) || 0
      : Math.max(propertyValue - downPayment, 0);
  if (income > 0 && loanAmount > 0) {
    const months = loanAmount / income;
    if (months <= 84) score += 2;
    else if (months <= 144) score += 1;
  }

  if (lead.expedienteProgreso?.completado) score += 1;

  return score;
}

function normalizeWhatsAppNumber(phone) {
  let cleaned = String(phone).trim().replace(/^whatsapp:/i, "");
  cleaned = cleaned.replace(/\D/g, "");
  if (cleaned.length === 10) cleaned = "52" + cleaned;
  return "whatsapp:+" + cleaned;
}

function fmtMoney(n) {
  const v = Number(n) || 0;
  return "$" + v.toLocaleString("es-MX");
}

function buildAlertBody(lead, leadId, score, trigger) {
  const name = lead.fullName || "(sin nombre)";
  const phone = lead.phone || "(sin teléfono)";
  const purpose = lead.loanPurpose === "refinanciamiento" ? "refinanciamiento" : "compra";
  const income = fmtMoney(lead.monthlyIncome);
  const propertyValue = fmtMoney(lead.propertyValue);
  const credit = lead.creditScore || "—";
  const expedienteOk = lead.expedienteProgreso?.completado ? "✅" : "⏳";

  return [
    `🔥 *Lead calificado* (${score}/10) — ${trigger}`,
    "",
    `👤 ${name}`,
    `📱 ${phone}`,
    `🎯 ${purpose} | crédito: ${credit}`,
    `💰 Ingreso: ${income} | Inmueble: ${propertyValue}`,
    `📁 Expediente: ${expedienteOk}`,
    "",
    `🔗 https://homeloans.mx/crm.html?lead=${leadId}`,
  ].join("\n");
}

/**
 * Envía alerta al agente si el lead supera el umbral y no fue notificado antes.
 * No-op silencioso si faltan envs o si ya se notificó.
 *
 * @param {object} args
 * @param {object} args.twilioClient  cliente Twilio ya inicializado
 * @param {object} args.db            Firestore admin instance
 * @param {string} args.leadId        ID del doc en `solicitudes`
 * @param {object} args.lead          datos completos del lead (post-merge)
 * @param {string} args.trigger       descripción corta del disparador (ej. "form web", "expediente completo")
 */
export async function maybeAlertAgent({ twilioClient, db, leadId, lead, trigger }) {
  const agentPhone = process.env.AGENT_NOTIFICATION_PHONE;
  const fromNumber = process.env.TWILIO_WHATSAPP_NUMBER;
  const threshold = Number(process.env.AGENT_ALERT_SCORE_THRESHOLD) || DEFAULT_THRESHOLD;

  if (!agentPhone || !fromNumber || !twilioClient) return;
  if (lead?.agentAlertedAt) return; // ya avisado para este lead

  const score = scoreLead(lead);
  if (score < threshold) return;

  const body = buildAlertBody(lead, leadId, score, trigger);
  try {
    await twilioClient.messages.create({
      from: normalizeWhatsAppNumber(fromNumber),
      to: normalizeWhatsAppNumber(agentPhone),
      body,
    });
    console.log(`[ALERT] Agente notificado lead ${leadId} score=${score} trigger=${trigger}`);
    if (db) {
      await db.collection("solicitudes").doc(leadId).set(
        {
          agentAlertedAt: FieldValue.serverTimestamp(),
          agentAlertedScore: score,
          agentAlertedTrigger: trigger,
        },
        { merge: true }
      );
    }
  } catch (e) {
    console.error("[ALERT] Falló envío al agente:", e.code, e.message);
  }
}
