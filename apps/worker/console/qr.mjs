// Prints a scannable QR for a URL in the terminal: node qr.mjs <url>. Used by the installers for the phone link.
import { createRequire } from "node:module";
createRequire(import.meta.url)("qrcode-terminal").generate(process.argv[2] ?? "", { small: true });
