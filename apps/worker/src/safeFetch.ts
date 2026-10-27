// Fetch a web page or file the comic pasted a link to, without letting a link reach inside the server's network: http(s) only,
// the address must be public (checked on the connection itself, so a name can't change its answer between check and connect),
// redirects are re-checked, and the size and time are capped.
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";

export class FetchBlockedError extends Error {}

const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

/** Public unicast address? Private, loopback, link-local, shared, multicast and documentation ranges are all refused. */
export function isPublicIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split(".").map(Number) as [number, number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicIp(mapped[1]!);
    const v4hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (v4hex) {
      const hi = parseInt(v4hex[1]!, 16);
      const lo = parseInt(v4hex[2]!, 16);
      return isPublicIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (lower === "::" || lower === "::1") return false;
    const first = parseInt(lower.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7
    if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10
    if ((first & 0xff00) === 0xff00) return false; // multicast
    if (lower.startsWith("64:ff9b:") || lower.startsWith("2001:db8:") || lower.startsWith("2001:0db8:")) return false;
    return true;
  }
  return false;
}

/** A lookup that only ever answers with public addresses. Used for the connection itself. */
const safeLookup: net.LookupFunction = (host, opts, cb) => {
  dns.lookup(host, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err, "", 4);
    const list = (addrs as dns.LookupAddress[]).filter((a) => isPublicIp(a.address));
    if (!list.length) return cb(new FetchBlockedError("That address is private, so I won't open it."), "", 4);
    if (opts.all) return (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });
};

/** Throws FetchBlockedError for anything that isn't a plain public http(s) link. */
export function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new FetchBlockedError("That doesn't look like a web address.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new FetchBlockedError("Only http and https links can be opened.");
  if (u.username || u.password) throw new FetchBlockedError("Links with a username or password in them aren't opened.");
  if (!ALLOWED_PORTS.has(u.port)) throw new FetchBlockedError("That link uses an unusual port, so I won't open it.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !isPublicIp(host)) throw new FetchBlockedError("That address is private, so I won't open it.");
  if (!net.isIP(host) && (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes("."))) {
    throw new FetchBlockedError("That address is private, so I won't open it.");
  }
  return u;
}

export interface Fetched {
  url: string;
  contentType: string;
  body: Buffer;
}

export interface FetchOpts {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

export function safeFetch(raw: string, opts: FetchOpts = {}): Promise<Fetched> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRedirects = opts.maxRedirects ?? 3;
  const deadline = Date.now() + timeoutMs;
  const hop = (urlStr: string, left: number): Promise<Fetched> =>
    new Promise<Fetched>((resolve, reject) => {
      let u: URL;
      try {
        u = checkUrl(urlStr);
      } catch (e) {
        return reject(e);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return reject(new Error("The page took too long to answer."));
      const req = (u.protocol === "https:" ? https : http).request(
        u,
        { method: "GET", lookup: safeLookup, headers: { "user-agent": "NothingBotRosterImport/1.0", accept: "text/html,text/csv,text/plain,application/json,application/pdf,image/*,*/*;q=0.5", "accept-encoding": "identity" }, timeout: remaining },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (left <= 0) return reject(new Error("The link redirects too many times."));
            return hop(new URL(res.headers.location, u).toString(), left - 1).then(resolve, reject);
          }
          if (status < 200 || status >= 300) {
            res.resume();
            return reject(new Error(`The page answered ${status}.`));
          }
          const declared = Number(res.headers["content-length"] ?? 0);
          if (declared > maxBytes) {
            res.destroy();
            return reject(new Error("That file is too big to read."));
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > maxBytes) {
              res.destroy();
              reject(new Error("That file is too big to read."));
            } else chunks.push(c);
          });
          res.on("end", () => resolve({ url: u.toString(), contentType: String(res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase(), body: Buffer.concat(chunks) }));
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error("The page took too long to answer.")));
      req.on("error", (e) => reject(e instanceof FetchBlockedError ? e : new Error(/ENOTFOUND|EAI_AGAIN/.test(String((e as NodeJS.ErrnoException).code)) ? "I couldn't find that web address." : `Couldn't open that link (${(e as Error).message}).`)));
      req.end();
    });
  return hop(raw, maxRedirects);
}
