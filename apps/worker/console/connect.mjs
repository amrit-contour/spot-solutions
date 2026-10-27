// "Connect with your Nothing BOT Curating account": the console asks the start function for a one-time link, shows it as a
// link and QR, and polls until an admin approves it in the web app. The console proves itself with a secret that
// never leaves this machine except as a hash, and the key only ever comes back in the reply to that proof.
import "./envcompat.mjs";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const WEB_BASE = process.env.NBS_WEB_URL ?? "https://nothingbotcurating.web.app";
const FN_BASE = process.env.NBS_FUNCTIONS_URL ?? "https://asia-south1-spot-solutions.cloudfunctions.net";
const POLL_MS = Number(process.env.NBS_CONNECT_POLL_MS ?? 3000);

/** An SVG QR (black on white, with its quiet zone) so it scans in light and dark themes alike. null if the library is missing. */
export function qrSvg(text) {
  try {
    const QRCode = require("qrcode-terminal/vendor/QRCode");
    const { M } = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");
    const q = new QRCode(-1, M);
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    const pad = 4;
    let d = "";
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.modules[y][x]) d += `M${x + pad} ${y + pad}h1v1h-1z`;
    const size = n + pad * 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  } catch {
    return null;
  }
}

export const connectLink = (code, base = WEB_BASE) => `${base}/connect-server?c=${encodeURIComponent(code)}`;

/**
 * onApproved({ key, approvedBy, serviceAccount }) installs the key; it throws if it can't, and the flow reports it.
 * Nothing secret is kept in the state the browser sees.
 */
export function createConnect({ hostname, onApproved, fetchImpl = fetch, now = Date.now, pollMs = POLL_MS }) {
  let st = { phase: "idle" };
  let secret = null;
  let timer = null;
  let session = 0;

  const post = async (fn, body, timeout = 120_000) => {
    const r = await fetchImpl(`${FN_BASE}/${fn}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body: j };
  };
  const stop = () => { clearTimeout(timer); timer = null; };

  async function tick(mine) {
    if (mine !== session || st.phase !== "waiting") return;
    if (now() >= st.expiresAt) { secret = null; st = { phase: "expired", deviceName: st.deviceName }; return; }
    let r;
    try {
      r = await post("pollDeviceLink", { code: st.code, secret });
    } catch {
      timer = setTimeout(() => tick(mine), pollMs * 2); // offline for a moment: keep trying until the link expires
      return;
    }
    if (mine !== session) return;
    if (!r.ok) {
      secret = null;
      st = { phase: "error", error: r.body.error || "Nothing BOT Curating couldn't check this link. Try again.", deviceName: st.deviceName };
      return;
    }
    const b = r.body;
    if (b.status === "pending") { timer = setTimeout(() => tick(mine), pollMs); return; }
    if (b.status === "approved" && b.key) {
      st = { ...st, phase: "installing", approvedBy: b.approvedBy };
      try {
        await onApproved({ key: b.key, approvedBy: b.approvedBy, serviceAccount: b.serviceAccount });
        secret = null;
        st = { phase: "done", approvedBy: b.approvedBy, serviceAccount: b.serviceAccount, deviceName: st.deviceName };
      } catch (e) {
        secret = null;
        st = { phase: "error", error: e.message || "Couldn't save the key on this server.", deviceName: st.deviceName };
      }
      return;
    }
    secret = null;
    st = b.status === "done"
      ? { phase: "error", error: "This link was already used. Start again.", deviceName: st.deviceName }
      : { phase: "expired", deviceName: st.deviceName };
  }

  return {
    async start(deviceName) {
      stop();
      const mine = ++session;
      secret = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(secret).digest("hex");
      const name = String(deviceName ?? "").trim() || hostname;
      let r;
      try {
        r = await post("startDeviceLink", { deviceName: name, challenge }, 30_000);
      } catch {
        secret = null;
        st = { phase: "error", error: "Couldn't reach Nothing BOT Curating. Check this server's internet and try again.", deviceName: name };
        return this.state();
      }
      if (!r.ok) {
        secret = null;
        st = { phase: "error", error: r.body.error || "Couldn't start. Try again.", deviceName: name };
        return this.state();
      }
      const { code, expiresAt, verify } = r.body;
      st = { phase: "waiting", code, link: connectLink(code), verify, expiresAt, deviceName: name };
      timer = setTimeout(() => tick(mine), pollMs);
      return this.state();
    },
    cancel() { stop(); session++; secret = null; st = { phase: "idle" }; },
    /** What the page may see: never the secret. */
    state() {
      const { phase, link, verify, expiresAt, error, approvedBy, serviceAccount, deviceName } = st;
      return { phase, link, verify, expiresAt, error, approvedBy, serviceAccount, deviceName, qr: link ? qrSvg(link) : null };
    },
  };
}
