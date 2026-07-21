import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { initializeFirestore } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

// Initialize Firestore with the custom databaseId provided in the config.
// `ignoreUndefinedProperties` prevents writes from crashing when an object has
// optional fields set to `undefined` (e.g. a plant line with no notes/vendor);
// those fields are simply omitted instead of throwing and dropping the whole save.
export const db = initializeFirestore(
  app,
  { ignoreUndefinedProperties: true },
  firebaseConfig.firestoreDatabaseId || '(default)'
);
