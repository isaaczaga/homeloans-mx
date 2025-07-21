// /api/enviar-calificacion.js
import { initializeApp, getApps } from "firebase/app";
import { getFirestore, collection, addDoc, serverTimestamp } from "firebase/firestore";

// --- Configuración de Firebase ---
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};

// --- Inicializar Firebase de forma segura ---
let app;
if (!getApps().length) {
    // Validar que las variables de entorno se cargaron
    if (!firebaseConfig.projectId) {
        // Este es el error que probablemente está ocurriendo.
        // Devolvemos un error 500 (error de servidor) con un mensaje claro.
        console.error("ERROR: Las variables de entorno de Firebase no se cargaron.");
        // No continuamos si no hay configuración.
    } else {
        app = initializeApp(firebaseConfig);
    }
} else {
    app = getApps()[0];
}

// Solo obtenemos la base de datos si la app se inicializó correctamente
const db = app ? getFirestore(app) : null;

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method Not Allowed' });
    }

    // Si la base de datos no se pudo inicializar, devolvemos un error.
    if (!db) {
        return res.status(500).json({ success: false, message: 'Error de configuración del servidor: no se pudo conectar a la base de datos.' });
    }

    const data = req.body;
    const payload = {
        fullName: data.fullName, email: data.email, phone: data.phone,
        loanPurpose: data.loanPurpose, propertyValue: data.propertyValue,
        monthlyIncome: data.monthlyIncome, creditScore: data.creditScore,
        fecha: serverTimestamp(), estado: 'Pre-calificación Recibida'
    };

    if (data.loanPurpose === 'compra') {
        payload.downPayment = data.downPayment;
    } else if (data.loanPurpose === 'refinanciamiento') {
        payload.currentBalance = data.currentBalance;
        payload.currentInterestRate = data.currentInterestRate;
        payload.currentBank = data.currentBank;
    }

    try {
        console.log("Intentando guardar en Firestore con Project ID:", process.env.FIREBASE_PROJECT_ID);
        
        const docRef = await addDoc(collection(db, "solicitudes"), payload);
        console.log("¡ÉXITO! Documento escrito con ID: ", docRef.id);
        
        res.status(200).json({ success: true, message: 'Solicitud guardada.', docId: docRef.id });

    } catch (error) {
        console.error('Error detallado al guardar en Firestore:', error);
        return res.status(500).json({ success: false, message: 'Error al escribir en la base de datos.' });
    }
}
