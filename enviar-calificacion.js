// /api/enviar-calificacion.js
import { initializeApp, getApps } from "firebase/app";
import { getFirestore, collection, addDoc, serverTimestamp } from "firebase/firestore";
import { firebaseConfig } from './firebase-config.js';

// --- Inicializar Firebase de forma segura ---
let app;
if (!getApps().length) {
    app = initializeApp(firebaseConfig);
} else {
    app = getApps()[0];
}
const db = getFirestore(app);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method Not Allowed' });
    }

    const data = req.body;

    // Construir el objeto de datos limpio para guardar en la base de datos
    const payload = {
        fullName: data.fullName,
        email: data.email,
        phone: data.phone,
        loanPurpose: data.loanPurpose,
        propertyValue: data.propertyValue,
        monthlyIncome: data.monthlyIncome,
        creditScore: data.creditScore,
        fecha: serverTimestamp()
    };

    if (data.loanPurpose === 'compra') {
        payload.downPayment = data.downPayment;
    } else if (data.loanPurpose === 'refinanciamiento') {
        payload.currentBalance = data.currentBalance;
        payload.currentInterestRate = data.currentInterestRate;
        payload.currentBank = data.currentBank;
    }

    // --- Guardar en la Base de Datos (Firestore) ---
    try {
        console.log("Intentando guardar en Firestore con Project ID:", firebaseConfig.projectId);
        
        const docRef = await addDoc(collection(db, "solicitudes"), payload);
        console.log("¡ÉXITO! Documento escrito con ID: ", docRef.id);

        // Si se guarda correctamente, enviamos una respuesta de éxito.
        res.status(200).json({ success: true, message: 'Solicitud guardada correctamente.' });

    } catch (error) {
        console.error('Error detallado al guardar en Firestore:', error);
        return res.status(500).json({ success: false, message: 'Error al conectar con la base de datos.' });
    }
}
