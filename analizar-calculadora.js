</summary>

// /api/analizar-calculadora.js
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method Not Allowed' });
    }
    try {
        const { loanAmount, monthlyPayment, loanTerm, totalInterest } = req.body;
        if (!loanAmount || !monthlyPayment || !loanTerm || !totalInterest) {
            return res.status(400).json({ message: 'Faltan datos para el análisis.' });
        }
        const prompt = `Actúa como un asesor financiero amigable y experto en hipotecas en México. Un cliente acaba de usar una calculadora y obtuvo los siguientes resultados:\n- Monto del Préstamo: ${loanAmount} MXN\n- Pago Mensual: ${monthlyPayment} MXN\n- Plazo: ${loanTerm} años\n- Interés Total Pagado: ${totalInterest} MXN\n\nExplica estos resultados de una manera sencilla, positiva y alentadora. Tu explicación debe:\n1. Ser breve y fácil de entender para alguien sin experiencia financiera.\n2. Explicar qué significa el pago mensual en el contexto de un presupuesto familiar.\n3. Dar una perspectiva positiva sobre el interés total, explicándolo como el costo de asegurar una vivienda a largo plazo.\n4. Terminar con una nota de ánimo, reforzando que este es un paso importante hacia la compra de su hogar.\n\nUsa un tono cercano y profesional. Formatea la respuesta en HTML simple, usando <br> para saltos de línea y <strong> para resaltar cifras clave. No uses markdown.`;
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
        console.error('Error in Gemini calculator analysis API:', error);
        res.status(500).json({ success: false, message: 'Error al generar el análisis.' });
    }
}
