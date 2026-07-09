/**
 * ═══════════════════════════════════════════════════════════════
 * HOMELOANS.MX — CONVERSIONS API (CAPI) — CLOUDFLARE WORKER
 * ═══════════════════════════════════════════════════════════════
 *
 * DESCRIPCIÓN:
 * Este Worker recibe eventos del sitio web (Lead, ViewContent, etc.)
 * y los reenvía a la API de Conversiones de Meta desde el servidor,
 * recuperando las conversiones perdidas por bloqueadores de ads e iOS 14+.
 *
 * DEPLOY GRATUITO:
 * 1. Crear cuenta en cloudflare.com (gratis)
 * 2. Ir a Workers & Pages → Create Worker
 * 3. Pegar este código completo
 * 4. Agregar variables de entorno (secrets):
 *    - FACEBOOK_ACCESS_TOKEN → tu token de sistema de Meta
 *    - PIXEL_ID → 2219149935562688
 * 5. Deploy → copiar la URL del worker
 * 6. Reemplazar 'homeloans-capi.TU_SUBDOMINIO.workers.dev' en pixel-v2-parches.html
 *
 * LÍMITE GRATUITO: 100,000 solicitudes/día (más que suficiente)
 * ═══════════════════════════════════════════════════════════════
 */

export default {
  async fetch(request, env) {

    // ── CORS — solo permitir desde homeloans.mx ──
    const allowedOrigins = [
      'https://www.homeloans.mx',
      'https://homeloans.mx',
      'http://localhost:3000',   // desarrollo local
      'http://127.0.0.1:5500',   // Live Server VSCode
    ];

    const origin = request.headers.get('Origin') || '';
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedOrigins.includes(origin) ? origin : 'https://www.homeloans.mx',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    // ── Preflight CORS ──
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ── Solo POST en /event ──
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/event') {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── Parsear body del evento ──
    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── Validar campos requeridos ──
    if (!payload.event_name || !payload.event_time) {
      return new Response(JSON.stringify({ error: 'Missing required fields: event_name, event_time' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── Construir evento para Meta CAPI ──
    const clientIp = request.headers.get('CF-Connecting-IP') ||
                     request.headers.get('X-Forwarded-For') ||
                     '0.0.0.0';

    const userAgent = request.headers.get('User-Agent') || '';

    // user_data — combinar datos del cliente con IP y UA del servidor
    const userData = {
      ...(payload.user_data || {}),
      client_ip_address: clientIp,
      client_user_agent: userAgent,
    };

    // Remover valores null/undefined
    Object.keys(userData).forEach(k => {
      if (!userData[k]) delete userData[k];
    });

    // Construir el evento completo
    const metaEvent = {
      event_name:        payload.event_name,
      event_time:        payload.event_time,
      event_id:          payload.event_id || `hl_${Date.now()}_${Math.random().toString(36).substr(2,9)}`,
      event_source_url:  payload.event_source_url || 'https://www.homeloans.mx',
      action_source:     payload.action_source || 'website',
      user_data:         userData,
      custom_data:       payload.custom_data || {},
    };

    // ── Enviar a Meta CAPI ──
    const pixelId    = env.PIXEL_ID || '2219149935562688';
    const accessToken = env.FACEBOOK_ACCESS_TOKEN;

    if (!accessToken) {
      console.error('[CAPI] FACEBOOK_ACCESS_TOKEN no configurado');
      return new Response(JSON.stringify({ error: 'Server configuration error' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const capiUrl = `https://graph.facebook.com/v19.0/${pixelId}/events`;

    const capiPayload = {
      data: [metaEvent],
      // test_event_code: 'TEST12345',  // ← Descomentar solo para testing
    };

    let capiResponse, capiData;
    try {
      capiResponse = await fetch(`${capiUrl}?access_token=${accessToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(capiPayload),
      });
      capiData = await capiResponse.json();
    } catch (err) {
      console.error('[CAPI] Error calling Meta API:', err);
      return new Response(JSON.stringify({ error: 'Failed to reach Meta API', details: err.message }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── Log del resultado ──
    console.log(`[CAPI] Event: ${payload.event_name} | Status: ${capiResponse.status} | Events received: ${capiData.events_received || 0}`);

    // ── Responder al cliente ──
    return new Response(JSON.stringify({
      success: capiResponse.ok,
      events_received: capiData.events_received || 0,
      event_name: payload.event_name,
      fbtrace_id: capiData.fbtrace_id || null,
    }), {
      status: capiResponse.ok ? 200 : capiResponse.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};
