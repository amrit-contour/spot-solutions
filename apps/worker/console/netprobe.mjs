// "Is the internet reachable?": a DNS lookup and an HTTPS request to Firestore (what the worker needs). Any HTTP answer counts, even 404.
import dns from "node:dns/promises";
import https from "node:https";

export const PROBE_HOST = "firestore.googleapis.com";

export async function probeInternet({ host = PROBE_HOST, timeoutMs = 8000 } = {}) {
  try { await dns.lookup(host); } catch { return false; }
  return new Promise((resolve) => {
    const req = https.request({ host, path: "/", method: "HEAD", timeout: timeoutMs }, (res) => { res.resume(); resolve(true); });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  });
}
