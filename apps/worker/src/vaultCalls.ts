// Thin wrappers over vault.ts for the caller duties the vault documents.
import { adoptCloudGen, prepareLogin, uploadLogin } from "./vault.ts";

/** prepareLogin throws only when there is no local profile and the download failed: that means "scan a QR". */
export async function prepareLoginSafe(uid: string): Promise<"local" | "cloud" | "fresh"> {
  try {
    return await prepareLogin(uid);
  } catch (e) {
    console.warn(`[fleet] ${uid} login restore failed, starting fresh:`, (e as Error).message);
    return "fresh";
  }
}

export { adoptCloudGen, uploadLogin };
