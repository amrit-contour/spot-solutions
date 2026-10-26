// /install: one public page for installing a server. It picks the right instructions for this computer; the console
// that opens afterwards is identical everywhere (docs/multi-server.md).
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Logo } from "../components/Logo";
import { Card, Segmented, buttonClass } from "../components/ui";

type Os = "mac" | "windows" | "linux";
const BASE = "https://spot-solutions.web.app";

function detect(): Os {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Linux/i.test(ua) && !/Android/i.test(ua)) return "linux";
  return "mac";
}

function Cmd({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative my-3 text-left">
      <pre className="overflow-x-auto rounded-md bg-surface-container px-4 py-3 pr-20 font-mono text-[13px] leading-6 text-on-surface">{children}</pre>
      <button
        onClick={() =>
          void navigator.clipboard.writeText(children).then(
            () => {
              setCopied(true);
              toast.success("Copied");
              setTimeout(() => setCopied(false), 1500);
            },
            () => toast.error("Couldn't copy. Select the text and copy it."),
          )
        }
        className="state-layer absolute top-2 right-2 rounded-full bg-surface-high px-3 py-1 type-label-m text-on-surface-variant"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function InstallPage() {
  const [os, setOs] = useState<Os>(detect);
  const needs = os === "mac" ? "A Mac on macOS 13 or newer, Apple Silicon or Intel." : os === "windows" ? "Windows 10 or 11." : "Ubuntu 24.04 or newer, Debian or Kali.";
  return (
    <div className="min-h-dvh bg-surface px-4 py-10">
      <div className="mx-auto w-full max-w-xl">
        <Logo className="size-14" />
        <h1 className="mt-6 type-display-s text-balance">Install Nothing BOT Server</h1>
        <p className="mt-3 type-body-l text-on-surface-variant">
          Turn a computer that stays on into your Nothing BOT Server. It keeps WhatsApp linked and reads DMs with a model on that computer or Gemini. Same steps and same console on every system.
        </p>
        <div className="mt-6">
          <Segmented<Os>
            value={os}
            onChange={setOs}
            options={[
              { value: "mac", label: "macOS" },
              { value: "windows", label: "Windows" },
              { value: "linux", label: "Ubuntu / Linux" },
            ]}
          />
        </div>

        <Card className="mt-6 p-5 sm:p-6">
          <h2 className="type-title-m">1. Install</h2>
          <p className="mt-1 type-body-s text-on-surface-variant">{needs} Keep it plugged in and online. About 8 GB of memory is best; with less, it uses Gemini instead of a local model.</p>
          {os === "mac" && (
            <>
              <p className="mt-3 type-body-m">Open Terminal and run:</p>
              <Cmd>{`curl -fsSL ${BASE}/install.sh | bash`}</Cmd>
              <p className="type-body-s text-on-surface-variant">
                It installs the Nothing BOT Server app, sets the Mac up and opens it. Prefer to click? Download <a className="text-primary underline-offset-4 hover:underline" href="/dl/SpotServer-mac.zip" download>SpotServer-mac.zip</a>, drag the app to Applications, open it and click Set up this Mac (macOS may ask you to allow it under Privacy &amp; Security).
              </p>
            </>
          )}
          {os === "windows" && (
            <>
              <div className="mt-3">
                <a className={buttonClass({})} href="/dl/SpotSolutions-Windows.zip" download>
                  Download for Windows
                </a>
              </div>
              <p className="mt-3 type-body-s text-on-surface-variant">Unzip it, double-click Install Nothing BOT Server.cmd and click Yes on the admin prompt. Or run this in PowerShell as Administrator:</p>
              <Cmd>{`Set-ExecutionPolicy -Scope Process Bypass -Force\nirm ${BASE}/install.ps1 | iex`}</Cmd>
            </>
          )}
          {os === "linux" && (
            <>
              <p className="mt-3 type-body-m">In a terminal on the server (or over SSH):</p>
              <Cmd>{`curl -fsSL ${BASE}/install.sh | sudo bash`}</Cmd>
              <p className="type-body-s text-on-surface-variant">It installs everything and sets up services that start at boot. At the end it prints the console link.</p>
            </>
          )}
        </Card>

        <Card className="mt-4 p-5 sm:p-6">
          <h2 className="type-title-m">2. Connect it</h2>
          <p className="mt-1 type-body-m text-on-surface-variant">
            In the server console (it opens by itself, or use the link the installer printed), click <b>Connect with Nothing BOT Curating</b>. Open the link or scan the QR with your phone, sign in with Google as an admin, and approve. No key files.
          </p>
          <h2 className="mt-5 type-title-m">3. Pick its AI</h2>
          <p className="mt-1 type-body-m text-on-surface-variant">
            Local model or Gemini only is chosen in the console under <b>AI models</b>, and can be switched any time. The server then keeps itself up to date.
          </p>
        </Card>

        <p className="mt-6 type-body-s text-on-surface-variant">
          Already an admin? <Link className="text-primary underline-offset-4 hover:underline" to="/help">Read the full server guide</Link> (sign in required).
        </p>
      </div>
    </div>
  );
}
