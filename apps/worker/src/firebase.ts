import { readFileSync } from "node:fs";
import { cert, initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { ttlMs } from "@spot/shared";

const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT;
const key = keyPath ? (JSON.parse(readFileSync(keyPath, "utf8")) as { client_email?: string }) : null;
/** The service account this server runs as, reported in its heartbeat so "Remove server" revokes exactly this key. */
export const SERVICE_ACCOUNT = key?.client_email ?? null;

initializeApp({
  credential: key ? cert(key as Parameters<typeof cert>[0]) : applicationDefault(),
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.SPOT_STORAGE_BUCKET || "spot-solutions.firebasestorage.app",
});

export const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

export { FieldValue };

/** Firestore TTL field: a Timestamp (not a number), `days` from now. Policies: deploy/setup-cost-controls.sh. */
export const expireAt = (days: number) => Timestamp.fromMillis(ttlMs(days));

export const userRef = (uid: string) => db.collection("users").doc(uid);
export const col = (uid: string, name: string) => userRef(uid).collection(name);
export const sessionRef = (uid: string) => col(uid, "session").doc("state");
