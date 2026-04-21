# Chatbot de WhatsApp — HomeLoans.mx

Chatbot conversacional que funciona como Isaac, asesor hipotecario virtual. Usa **Twilio** para WhatsApp, **Claude (Anthropic)** como cerebro y **Firebase Firestore** para guardar leads y el historial de conversaciones.

---

## Cómo funciona

```
Usuario de WhatsApp
       ↓
   Twilio Sandbox
       ↓
/api/whatsapp-webhook.js  (Vercel serverless)
       ↓ lee historial
   Firestore (whatsapp_sessions)
       ↓
   Claude API (Isaac responde)
       ↓ si lead calificado
   Firestore (solicitudes → aparece en CRM)
       ↓
   Twilio → WhatsApp
```

---

## 1. Credenciales necesarias

### Twilio
1. Crea cuenta en [twilio.com](https://twilio.com)
2. Ve a **Messaging > Try it out > Send a WhatsApp message**
3. Activa el sandbox de WhatsApp
4. Obtén:
   - `TWILIO_ACCOUNT_SID` — en el Dashboard principal
   - `TWILIO_AUTH_TOKEN` — en el Dashboard principal
   - `TWILIO_WHATSAPP_NUMBER` — es `whatsapp:+14155238886` para el sandbox

### Anthropic (Claude)
1. Crea cuenta en [console.anthropic.com](https://console.anthropic.com)
2. Ve a **API Keys** y genera una clave
3. Guárdala como `ANTHROPIC_API_KEY`

### Firebase
Las mismas variables que ya tienes configuradas en Vercel:
- `FIREBASE_API_KEY`
- `FIREBASE_AUTH_DOMAIN`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_STORAGE_BUCKET`
- `FIREBASE_MESSAGING_SENDER_ID`
- `FIREBASE_APP_ID`

---

## 2. Configurar variables de entorno

### Localmente (para pruebas)
Llena el archivo `.env` en la raíz del proyecto con tus credenciales reales. **Este archivo nunca se sube a GitHub.**

```bash
# Instalar dependencias
npm install
```

### En Vercel (producción)
1. Ve a tu proyecto en [vercel.com](https://vercel.com)
2. **Settings > Environment Variables**
3. Agrega cada variable del archivo `.env` con sus valores reales
4. Haz un nuevo deploy para que surtan efecto

---

## 3. Configurar el webhook en Twilio

Una vez desplegado en Vercel, configura el webhook:

1. En la consola de Twilio → **Messaging > Settings > WhatsApp Sandbox Settings**
2. En **"When a message comes in"**, pon la URL de tu webhook:
   ```
   https://www.homeloans.mx/api/whatsapp-webhook
   ```
3. Método: **HTTP POST**
4. Guarda los cambios

### Para pruebas locales con ngrok
```bash
# En una terminal: exponer localhost
npx ngrok http 3000

# Usa la URL de ngrok en Twilio (ej: https://abc123.ngrok.io/api/whatsapp-webhook)
```

---

## 4. Activar el sandbox de Twilio (para pruebas)

En WhatsApp, envía este mensaje al número del sandbox:
```
join <código-de-tu-sandbox>
```
El código aparece en la sección WhatsApp Sandbox de Twilio (ej: `join red-lizard`).

---

## 5. Habilitar validación de firma (producción)

Para mayor seguridad en producción, agrega esta variable de entorno en Vercel:
```
VALIDATE_TWILIO_SIGNATURE=true
```
Esto verifica que los webhooks vengan realmente de Twilio.

---

## 6. Estructura de datos en Firestore

### Colección `whatsapp_sessions`
Guarda el historial de conversación por número de teléfono.
```json
{
  "messages": [
    { "role": "user", "content": "Hola, busco comprar en Polanco" },
    { "role": "assistant", "content": "¡Hola! Soy Isaac de HomeLoans.mx..." }
  ],
  "lastActivity": "Timestamp",
  "qualified": false
}
```

### Colección `solicitudes` (la misma del CRM)
Cuando Isaac tiene los 5 datos, crea un documento aquí con `source: "whatsapp_chatbot"`. Aparece automáticamente en el CRM en el panel de solicitudes.
```json
{
  "fullName": "Lead WhatsApp",
  "phone": "521234567890",
  "loanPurpose": "compra",
  "propertyValue": 15000000,
  "downPayment": 3000000,
  "monthlyIncome": 120000,
  "creditScore": "Excelente",
  "colonia": "Polanco",
  "source": "whatsapp_chatbot",
  "estado": "Recibida",
  "fecha": "Timestamp"
}
```

---

## 7. Personalizar el comportamiento de Isaac

Edita la constante `SYSTEM_PROMPT` en `/api/whatsapp-webhook.js` para ajustar:
- El tono y personalidad
- Las preguntas de calificación
- Las zonas o tipos de propiedades que maneja
- El umbral para considerar un lead calificado

---

## 8. Límites importantes

| Concepto | Valor |
|---|---|
| Timeout Vercel (hobby) | 10 segundos |
| Timeout Vercel (pro) | 60 segundos |
| Timeout Twilio webhook | 15 segundos |
| Historial máximo en memoria | 20 mensajes por sesión |
| Modelo Claude | `claude-sonnet-4-6` |

> Si los tiempos de respuesta de Claude son lentos, considera actualizar tu plan de Vercel a Pro para obtener 60 segundos de timeout.

---

## 9. Migrar de sandbox a número real de WhatsApp

Para usar un número de WhatsApp Business real (en lugar del sandbox de Twilio):
1. Solicita acceso a la API de WhatsApp Business en Twilio
2. Verifica tu número de empresa con Meta
3. Cambia `TWILIO_WHATSAPP_NUMBER` a `whatsapp:+TU_NUMERO_REAL`
4. Actualiza la URL del webhook en la configuración de tu número en Twilio
