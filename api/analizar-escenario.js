// /api/analizar-escenario.js
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method Not Allowed' });
    }
    try {
        const { currentBalance, currentInterestRate, monthlyIncome } = req.body;
        if (!currentBalance || !currentInterestRate || !monthlyIncome) {
            return res.status(400).json({ message: 'Faltan datos para el análisis.' });
        }
        const prompt = `Actúa como un asesor hipotecario experto en México. Un cliente está considerando refinanciar su crédito.\n- Saldo actual: ${currentBalance} MXN\n- Tasa de interés anual actual: ${currentInterestRate}%\n- Ingreso mensual bruto: ${monthlyIncome} MXN\n\nBasado en las condiciones típicas del mercado hipotecario mexicano para 2025, donde las tasas para perfiles con buen historial crediticio rondan el 9.5% al 10.5%, genera un breve análisis de su potencial de ahorro.\n\nEl análisis debe:\n1. Empezar con un encabezado positivo como "¡Buenas noticias! Refinanciar podría ser una gran idea.".\n2. Estimar una nueva tasa de interés realista que podría obtener (ej. 10.0%).\n3. Calcular y mostrar el ahorro mensual aproximado.\n4. Mencionar el ahorro total a lo largo del tiempo como un gran beneficio.\n5. Terminar con una llamada a la acción para completar el formulario.\n\nFormatea la respuesta de forma clara y concisa, usando saltos de línea. No uses markdown, solo texto plano.`;
        const apiKey = "";
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
        const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
        const apiResponse = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!apiResponse.ok) { throw new Error(`API call failed with status: ${apiResponse.status}`); }
        const result = await apiResponse.json();
        let analysisText = "No pudimos generar el análisis en este momento.";
        if (result.candidates && result.candidates[0]?.content?.parts?.[0]) {
            analysisText = result.candidates[0].content.parts[0].text;
        }
        res.status(200).json({ success: true, analysis: analysisText });
    } catch (error) {
        console.error('Error in Gemini analysis API:', error);
        res.status(500).json({ success: false, message: 'Error al generar el análisis.' });
    }
}
