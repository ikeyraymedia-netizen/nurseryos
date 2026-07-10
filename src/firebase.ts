import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

// Initialize Firestore with the custom databaseId provided in the config
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId || '(default)');
