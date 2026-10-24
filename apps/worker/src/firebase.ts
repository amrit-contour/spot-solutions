import { readFileSync } from "node:fs";
import { cert, initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT;

initializeApp({
  credential: keyPath ? cert(JSON.parse(readFileSync(keyPath, "utf8"))) : applicationDefault(),
  projectId: process.env.FIREBASE_PROJECT_ID,
});

export const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

export { FieldValue };

export const userRef = (uid: string) => db.collection("users").doc(uid);
export const col = (uid: string, name: string) => userRef(uid).collection(name);
export const sessionRef = (uid: string) => col(uid, "session").doc("state");
