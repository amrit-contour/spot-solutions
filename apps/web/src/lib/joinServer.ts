// Add / remove a server through the Cloud Functions (functions/src/index.ts, docs/multi-server.md).
import { getApp } from "firebase/app";
import { getFunctions, httpsCallable } from "firebase/functions";

// Same region as the functions; the app is initialised in ./firebase.
const fns = () => getFunctions(getApp(), "asia-south1");

export interface JoinCode {
  code: string;
  /** ms since the epoch */
  expiresAt: number;
}

export interface RemoveResult {
  revoked: string[];
  /** No key made by Spot Solutions was linked to this server, so nothing was revoked. */
  keyNotRevoked: boolean;
}

export async function createJoinCode(deviceName?: string): Promise<JoinCode> {
  const r = await httpsCallable<{ deviceName?: string }, JoinCode>(fns(), "createJoinCode")({ deviceName });
  return r.data;
}

export async function removeServer(serverId: string, force = false): Promise<RemoveResult> {
  const r = await httpsCallable<{ serverId: string; force: boolean }, RemoveResult>(fns(), "removeServer", { timeout: 120_000 })({ serverId, force });
  return r.data;
}

/** The message the function wrote for the person (Firebase prefixes nothing, but be safe). */
export const joinError = (e: unknown) => ((e as Error).message || "Something went wrong. Try again.").replace(/^functions\/[a-z-]+:\s*/, "");
export const isPrecondition = (e: unknown) => (e as { code?: string }).code === "functions/failed-precondition";

// ---- connect a server by signing in (functions/src/link.ts, apps/worker/console/connect.mjs) ----

export interface DeviceLink {
  deviceName: string;
  status: "pending" | "approved" | "redeeming" | "done";
  /** ms since the epoch */
  expiresAt: number;
  /** Four characters the server's console also shows, so you approve the computer in front of you. */
  verify: string;
  canApprove: boolean;
}

export async function getDeviceLink(code: string): Promise<DeviceLink> {
  return (await httpsCallable<{ code: string }, DeviceLink>(fns(), "getDeviceLink")({ code })).data;
}

export async function approveDeviceLink(code: string): Promise<{ deviceName: string }> {
  return (await httpsCallable<{ code: string }, { deviceName: string }>(fns(), "approveDeviceLink")({ code })).data;
}
