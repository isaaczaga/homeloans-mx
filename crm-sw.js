/**
 * crm-sw.js
 * Service worker mínimo para que el CRM sea instalable como PWA.
 *
 * Diseño deliberadamente PASS-THROUGH (sin cache):
 *  - El CRM es una herramienta operacional sobre Firestore en tiempo real.
 *    Servir contenido cacheado podría mostrar leads/mensajes desactualizados,
 *    lo cual es peor que no tener PWA.
 *  - Solo proveemos lo mínimo que Chrome/iOS exige para considerarlo
 *    instalable: manifest + SW activo con un handler de fetch.
 *
 * Si en el futuro queremos cache offline para el shell del CRM (HTML/CSS/JS
 * estáticos), agregar aquí estrategia stale-while-revalidate SOLO para
 * recursos same-origin que no sean Firestore/API.
 */

const VERSION = "v1";

self.addEventListener("install", (event) => {
  console.log(`[CRM-SW] Instalando ${VERSION}`);
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  console.log(`[CRM-SW] Activado ${VERSION}`);
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  // Pass-through: dejamos que el navegador haga la request normal.
  // Solo registrar el handler ya basta para que el SW cuente como "activo"
  // y el sitio sea considerado instalable.
});
