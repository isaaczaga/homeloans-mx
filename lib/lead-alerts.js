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
  const email = lead.email || "";
  const credit = lead.creditScore || "—";
  const income = Number(lead.monthlyIncome) || 0;
  const propertyValue = Number(lead.propertyValue) || 0;
  const expedienteOk = lead.expedienteProgreso?.completado ? "✅ Completo" : "⏳ Pendiente";

  const lines = [
    `🆕 *Nuevo lead* — ${trigger} | Score ${score}/10`,
    "",
    `👤 ${name}`,
    `📱 ${phone}`,
  ];
  if (email) lines.push(`✉️ ${email}`);
  lines.push("");

  if (lead.loanPurpose === "refinanciamiento") {
    const balance = Number(lead.currentBalance) || 0;
    lines.push("🎯 *Refinanciamiento*");
    if (propertyValue) lines.push(`🏠 Inmueble: ${fmtMoney(propertyValue)}`);
    if (lead.currentBank) lines.push(`🏦 Banco actual: ${lead.currentBank}`);
    if (balance) lines.push(`💸 Saldo actual: ${fmtMoney(balance)}`);
    if (lead.currentInterestRate) lines.push(`📈 Tasa actual: ${lead.currentInterestRate}`);
  } else {
    const downPayment = Number(lead.downPayment) || 0;
    const loanAmount = Math.max(propertyValue - downPayment, 0);
    const downPct = propertyValue > 0 ? Math.round((downPayment / propertyValue) * 100) : 0;
    lines.push("🎯 *Compra*");
    if (propertyValue) lines.push(`🏠 Inmueble: ${fmtMoney(propertyValue)}`);
    if (downPayment) lines.push(`💵 Enganche: ${fmtMoney(downPayment)}${downPct ? ` (${downPct}%)` : ""}`);
    if (loanAmount) lines.push(`🧾 Préstamo solicitado: ${fmtMoney(loanAmount)}`);
  }

  if (income) lines.push(`💰 Ingreso: ${fmtMoney(income)}/mes`);
  lines.push(`📊 Crédito: ${credit}`);
  lines.push(`📁 Expediente: ${expedienteOk}`);
  lines.push("");
  lines.push(`🔗 https://homeloans.mx/crm.html?lead=${leadId}`);

  return lines.join("\n");
}

/**
 * Envía alerta al agente sobre un lead. Idempotente por `trigger` —
 * si el mismo lead ya fue notificado para ese disparador, no se reenvía.
 * No-op silencioso si faltan envs.
 *
 * Modo `gated: true` (opcional) sólo notifica si el score ≥ threshold.
 * Por default notifica SIEMPRE: estamos arrancando y queremos máxima
 * visibilidad sobre cada lead nuevo.
 *
 * @param {object} args
 * @param {object} args.twilioClient  cliente Twilio ya inicializado
 * @param {object} args.db            Firestore admin instance
 * @param {string} args.leadId        ID del doc en `solicitudes`
 * @param {object} args.lead          datos completos del lead (post-merge)
 * @param {string} args.trigger       descripción corta del disparador (ej. "form web", "expediente completo")
 * @param {boolean} [args.gated]      si true, sólo alerta cuando score ≥ threshold
 */
export async function maybeAlertAgent({ twilioClient, db, leadId, lead, trigger, gated = false }) {
  const agentPhone = process.env.AGENT_NOTIFICATION_PHONE;
  const fromNumber = process.env.TWILIO_WHATSAPP_NUMBER;
  const threshold = Number(process.env.AGENT_ALERT_SCORE_THRESHOLD) || DEFAULT_THRESHOLD;

  if (!agentPhone || !fromNumber || !twilioClient) return;

  // Idempotencia por trigger: el mismo lead puede generar alerta en
  // "form web" y luego en "expediente completo", pero no dos veces el mismo.
  const alertedTriggers = Array.isArray(lead?.agentAlertedTriggers)
    ? lead.agentAlertedTriggers
    : [];
  if (alertedTriggers.includes(trigger)) return;

  const score = scoreLead(lead);
  if (gated && score < threshold) return;

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
          agentAlertedTriggers: FieldValue.arrayUnion(trigger),
          agentLastAlertedAt: FieldValue.serverTimestamp(),
          agentLastAlertedScore: score,
        },
        { merge: true }
      );
    }
  } catch (e) {
    console.error("[ALERT] Falló envío al agente:", e.code, e.message);
  }
}
