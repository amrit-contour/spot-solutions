import { initializeApp } from "firebase/app";
import { GoogleAuthProvider, connectAuthEmulator, getAuth } from "firebase/auth";
import { connectFirestoreEmulator, initializeFirestore, memoryLocalCache, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";

// Local development against the Firebase emulators (VITE_USE_EMULATORS=1, a demo- project id): nothing touches the real project.
const emulate = import.meta.env.DEV && import.meta.env.VITE_USE_EMULATORS === "1";

const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  // Push needs the sender id, which is the project number inside the app id ("1:<number>:web:...").
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? String(import.meta.env.VITE_FIREBASE_APP_ID ?? "").split(":")[1],
});

export const auth = getAuth(app);
export const google = new GoogleAuthProvider();
export const db = initializeFirestore(app, {
  ignoreUndefinedProperties: true,
  localCache: emulate ? memoryLocalCache() : persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

if (emulate) {
  // Ports can be overridden (VITE_EMULATOR_AUTH_PORT / _FIRESTORE_PORT / _STORAGE_PORT) so a second set of emulators can run beside the first.
  connectAuthEmulator(auth, `http://127.0.0.1:${import.meta.env.VITE_EMULATOR_AUTH_PORT || 9099}`, { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", Number(import.meta.env.VITE_EMULATOR_FIRESTORE_PORT || 8080));
}
