import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCZOYKH1Cu_-fBvttX4Gm7J9OMFsUkbNuE",
  authDomain: "test-e6303.firebaseapp.com",
  projectId: "test-e6303",
  storageBucket: "test-e6303.firebasestorage.app",
  messagingSenderId: "345530126125",
  appId: "1:345530126125:web:208c40256d1c4d95df0da4",
  measurementId: "G-H7YPM4J5D0",
};

export function isFirebaseConfigured(): boolean {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);
}

const app = isFirebaseConfigured() ? initializeApp(firebaseConfig) : null;

export const firestore = app ? getFirestore(app) : null;
// An app using Firebase Auth would export `getAuth(app)` here too; see `sync.ts` for retrying
// the writes parked while signed out.
