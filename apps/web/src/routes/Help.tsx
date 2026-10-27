// Public server guide: nothingbotcurate.web.app/help. No sign-in needed.
import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { Segmented, cx } from "@spot/ui";
import { IconCheck, IconCpu, IconServer, IconShield, IconWarn } from "@spot/ui";

type Platform = "mac" | "windows" | "linux";
const PLATFORMS: { value: Platform; label: string }[] = [
  { value: "mac", label: "Mac" },
  { value: "windows", label: "Windows" },
  { value: "linux", label: "Ubuntu / Linux" },
];

const SECTIONS = [
  { id: "overview", title: "How it works" },
  { id: "before", title: "Before you start" },
  { id: "install", title: "Install the server" },
  { id: "setup", title: "First-time setup" },
  { id: "several-servers", title: "Running several servers" },
  { id: "primary", title: "Make another server your primary" },
  { id: "start-over", title: "Starting over" },
  { id: "everyday", title: "Start, stop and restart" },
  { id: "always-on", title: "Keep it always on" },
  { id: "logs", title: "Logs and health" },
  { id: "update", title: "Update" },
  { id: "data", title: "Your data and restarts" },
  { id: "troubleshooting", title: "Troubleshooting" },
  { id: "uninstall", title: "Uninstall" },
] as const;

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua) && !/iPhone|iPad/i.test(ua)) return "mac";
  if (/Linux/i.test(ua) && !/Android/i.test(ua)) return "linux";
  return "mac";
}

function Cmd({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative my-3">
      <pre className="overflow-x-auto rounded-md bg-surface-container px-4 py-3 pr-20 font-mono text-[13px] leading-6 text-on-surface">{children}</pre>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(children).then(() => {
            setCopied(true);
            toast.success("Copied");
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="state-layer absolute top-2 right-2 rounded-full bg-surface-high px-3 py-1 type-label-m text-on-surface-variant"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

const Code = ({ children }: { children: ReactNode }) => <code className="rounded-xs bg-surface-high px-1.5 py-0.5 font-mono text-[0.85em]">{children}</code>;
const P = ({ children }: { children: ReactNode }) => <p className="my-3 type-body-l text-on-surface-variant">{children}</p>;
const Steps = ({ children }: { children: ReactNode }) => <ol className="my-3 ml-5 list-decimal space-y-2 type-body-l text-on-surface-variant marker:text-primary marker:font-semibold">{children}</ol>;
const Bullets = ({ children }: { children: ReactNode }) => <ul className="my-3 ml-5 list-disc space-y-2 type-body-l text-on-surface-variant marker:text-outline">{children}</ul>;
const B = ({ children }: { children: ReactNode }) => <span className="font-semibold text-on-surface">{children}</span>;

function Callout({ tone = "info", children }: { tone?: "info" | "warn" | "ok"; children: ReactNode }) {
  const I = tone === "warn" ? IconWarn : tone === "ok" ? IconCheck : IconShield;
  return (
    <div className={cx("my-4 flex gap-3 rounded-lg px-4 py-3 type-body-m", tone === "warn" ? "bg-error-container text-on-error-container" : "bg-secondary-container text-on-secondary-container")}>
      <I className="icon mt-0.5 size-5 flex-none" />
      <div>{children}</div>
    </div>
  );
}

function Table({ rows, head }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="my-4 overflow-x-auto rounded-lg border border-outline-variant">
      <table className="w-full min-w-[520px] text-left type-body-m">
        <thead className="bg-surface-container type-label-l text-on-surface">
          <tr>{head.map((h) => <th key={h} className="px-4 py-2.5">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-outline-variant/60 text-on-surface-variant">
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} className="px-4 py-2.5 align-top">{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-outline-variant/50 py-10 first:border-0 first:pt-0">
      <h2 className="type-headline-s">{title}</h2>
      {children}
    </section>
  );
}

const MAC_CTL = '"/Applications/Nothing BOT Server.app/Contents/Resources/nbsctl"';

export function HelpPage() {
  const [os, setOs] = useState<Platform>(detectPlatform);
  const { hash } = useLocation();
  const [active, setActive] = useState("overview");

  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);
  useEffect(() => {
    const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && setActive(e.target.id)), { rootMargin: "-20% 0px -70% 0px" });
    SECTIONS.forEach((s) => { const el = document.getElementById(s.id); if (el) io.observe(el); });
    return () => io.disconnect();
  }, []);

  const pick = (
    <div className="sticky top-0 z-20 -mx-4 mb-8 bg-surface/90 px-4 py-3 backdrop-blur sm:mx-0 sm:px-0">
      <div className="flex flex-wrap items-center gap-3">
        <span className="type-label-l text-on-surface-variant">Server computer:</span>
        <Segmented value={os} onChange={setOs} options={PLATFORMS} />
      </div>
    </div>
  );

  return (
    <div className="w-full">
      <div className="flex gap-10 px-4 py-8 sm:px-8 sm:py-10">
        <nav aria-label="Guide sections" className="sticky top-6 order-last hidden h-fit w-56 flex-none xl:block">
          <ul className="space-y-0.5">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className={cx("block rounded-full px-4 py-2 type-label-l transition-colors", active === s.id ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant hover:bg-surface-container")}>
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <main className="min-w-0 max-w-3xl flex-1">
          <p className="type-label-l text-primary">Admins only</p>
          <h1 className="mt-1 type-display-s">Server guide</h1>
          <P>Everything you need to set up, run and look after the computer that keeps your WhatsApp connected and reads spot requests with Gemma. Pick your server's operating system below; the instructions change to match.</P>
          {pick}

          <Section id="overview" title="How it works">
            <P>Nothing BOT Curate has two halves:</P>
            <Bullets>
              <li><B>The app</B> (this website). You and other curators use it from any phone or computer to see requests, build lineups and send confirmations. Your data lives in the cloud (Firebase).</li>
              <li><B>The server</B>: one computer you keep on (an old laptop, a Mac, a Windows PC). It keeps each curator's WhatsApp linked, runs Gemma locally to read DMs, and sends the messages you approve.</li>
            </Bullets>
            <P>The server only makes outgoing connections, so there's nothing to open on your router and nothing to configure for remote access. The app works from anywhere, even on mobile data; the server just needs internet.</P>
            <Callout>One server can host several curators. Each gets their own WhatsApp link. Budget about 400 MB of memory per curator, plus about 4 GB for Gemma.</Callout>
          </Section>

          <Section id="before" title="Before you start">
            <Table
              head={["You need", "Details"]}
              rows={[
                ["A computer that can stay on", os === "mac" ? "Any Mac on macOS 13 or newer (Apple Silicon or Intel)" : os === "windows" ? "Windows 10 or 11 with the App Installer (winget). Most PCs already have it." : "Ubuntu 24.04 or newer, Debian or Kali. Installed onto the disk or a USB stick works too; a live USB doesn't."],
                ["Memory and disk", "8 GB RAM recommended, about 10 GB of free disk (the installer asks where to keep the data and AI models, and about 5 GB is needed there)"],
                ["Power and internet", "Plugged in, with Wi-Fi or Ethernet"],
                ["An admin account", <>You sign in with Google on the server, and approve it. Only admins can connect a server. See below.</>],
                ["Your phone", "To scan the WhatsApp QR code once"],
              ]}
            />
            <h3 id="get-code" className="mt-6 type-title-m">How a server connects</h3>
            <P>You don't need a key file or a code. After installing, the server console shows <B>Connect with your Nothing BOT Curate account</B>: a link and a QR code. Open it on the same computer or scan it with your phone, sign in with Google, check that the 4-character check matches, and approve. The server makes its own key, and your email becomes one of its admins. The link works once and lasts 15 minutes. Only admins can approve; anyone else sees "ask an admin".</P>
            <P><B>Prefer a code?</B> In the app, open <B>Account → Server</B>, click <B>Add a server</B>, then <B>Make a code</B> (like <Code>SPOT-7K3F-Q9TX</Code>, works once, lasts 15 minutes) and type it into the console under <B>Have a join code from the app?</B></P>
            <Callout>Each server gets its own key, made for it. Nothing to download or move around, and one server can be removed without touching the others. The only time you need a key file is the very first server of a brand-new project, before anyone is an admin: the console tucks that under <B>First server ever?</B></Callout>
          </Section>

          <Section id="install" title="Install the server">
            <P>One install for every computer, and the same console afterwards. There is also a download page that picks the right one for you: <Link className="text-primary underline-offset-4 hover:underline" to="/install">nothingbotcurating.web.app/install</Link>. Whether the server runs a local model or Gemini only is chosen later, in the console, and can be switched any time. The installer starts with a local model on computers with about 8 GB of memory or more.</P>
            {os === "mac" && (
              <>
                <P>Open <B>Terminal</B> and run:</P>
                <Cmd>curl -fsSL https://nothingbotcurating.web.app/install.sh | bash</Cmd>
                <P>This puts <B>Nothing BOT Server</B> in Applications, sets the Mac up (a few minutes the first time; it asks where to keep the data and AI models, with the disk that has the most room pre-selected, and refuses iCloud Drive, external and network disks) and opens the app. The older <Code>install-mac.sh</Code> address still works. Or download <a className="text-primary underline-offset-4 hover:underline" href={`/dl/NothingBotServer-mac.zip?v=${__BUILD_ID__}`} download>NothingBotServer-mac.zip</a>, double-click it and drag the app into Applications.</P>
                <Callout>Downloaded through a browser, macOS says it can't check the developer the first time. Open <B>System Settings → Privacy & Security</B> and click <B>Open Anyway</B>. The Terminal install avoids this.</Callout>
              </>
            )}
            {os === "windows" && (
              <>
                <Steps>
                  <li>Download <a className="text-primary underline-offset-4 hover:underline" href={`/dl/NothingBotServer-Windows.zip?v=${__BUILD_ID__}`} download>NothingBotServer-Windows.zip</a> and unzip it.</li>
                  <li>Double-click <B>Install Nothing BOT Server.cmd</B> and click <B>Yes</B> on the admin prompt.</li>
                  <li>Wait while it installs Node.js and, on a PC with about 8 GB of memory or more, Ollama and Gemma (about 3.5 GB).</li>
                </Steps>
                <P>Or, in PowerShell as Administrator:</P>
                <Cmd>{"Set-ExecutionPolicy -Scope Process Bypass -Force\nirm https://nothingbotcurating.web.app/install.ps1 | iex"}</Cmd>
                <P>A fresh install asks <B>Where should Nothing BOT keep its data and AI models?</B> It lists the drives with free space and pre-selects the fixed drive with the most room (Enter accepts it). It refuses OneDrive and other cloud-synced folders, USB and network drives and the program folder, and warns when there is under about 5 GB free. Re-installing and updating keep your choice and never ask again. For an unattended install use <Code>$env:NBS_DATA_DIR = "D:\Nothing BOT Server"</Code> and <Code>$env:NBS_YES = "1"</Code> before the command.</P>
                <P>When it finishes you'll have <B>Nothing BOT Server Console</B> and <B>Nothing BOT Curate</B> on the desktop and in the Start menu.</P>
              </>
            )}
            {os === "linux" && (
              <>
                <P>In a terminal on the server (or over SSH):</P>
                <Cmd>curl -fsSL https://nothingbotcurating.web.app/install.sh | sudo bash</Cmd>
                <P>It installs Node and (with about 8 GB of memory or more) Ollama and Gemma, and sets up services that start at boot and restart on crash: <Code>ollama</Code>, <Code>nothing-bot-server-worker</Code> and <Code>nothing-bot-server-console</Code>. At the end it prints the console link.</P>
                <P>On a fresh install it first asks <B>Where should Nothing BOT keep its data and AI models?</B>, listing the disks with free space and pre-selecting the one with the most room. Press Enter to accept it. It refuses cloud-synced folders, removable and network disks and the program folder, and warns when there is under about 5 GB free. For an unattended install, add <Code>NBS_DATA_DIR=/mnt/disk/nothing-bot-server</Code> (after <Code>sudo</Code>) or <Code>-s -- --yes</Code> to take the suggestion.</P>
                <Callout>Want a pocket server? Install Ubuntu Server onto a USB stick (a full install, not a live USB) and boot the laptop from it. See the <a className="underline" href="#always-on">always-on</a> tips below.</Callout>
              </>
            )}
          </Section>

          <Section id="setup" title="First-time setup">
            <Steps>
              {os === "mac" && <li>If the install command didn't already set the Mac up, click <B>Set up this Mac</B> in Nothing BOT Server. You can watch the progress in the window.</li>}
              <li>
                Open the <B>server console</B>
                {os === "mac" ? " (it's inside the Nothing BOT Server window)" : os === "windows" ? " (the Nothing BOT Server Console shortcut; it opens by itself after installing)" : <> from a phone or laptop on the same Wi-Fi, using the link the installer printed. Lost it? Run <Code>sudo nbs-console-url</Code></>}
                .
              </li>
              <li>Click <B>Connect with Nothing BOT Curate</B>, open the link (or scan the QR with your phone), sign in with Google and approve. The worker starts by itself, and your email is added as an admin so the server shows in the app under <B>Account → Server</B>. A join code from the app works too; see <a className="underline" href="#get-code">above</a>.</li>
              <li>Optional: open <B>AI models</B> in the console to add a Gemini key (it's checked with Google before it's saved), pick models, test them, or turn the local model on or off.</li>
              <li>On any computer, open <Link className="text-primary underline-offset-4 hover:underline" to="/settings">Nothing BOT Curate → Settings</Link> → <B>Show QR code</B>, and scan it from WhatsApp on your phone (<B>Settings → Linked devices → Link a device</B>).</li>
            </Steps>
            <Callout tone="ok">That's it. From now on you can manage the server from the app, from anywhere. The console is only needed to join.</Callout>
            <P>Other curators don't touch the server. They sign in on the website, you approve them under <B>Account → Server → Curators</B>, and they link their own WhatsApp from their Settings.</P>
          </Section>

          <Section id="several-servers" title="Running several servers">
            <P>You can run as many servers as you like. Each WhatsApp account runs on one server at a time. If that server goes offline, another one takes the account over with its saved login, with no new QR scan.</P>
            <P><B>One key per device.</B> Never copy one Firebase key between computers. A join code makes each server its own key (see <a className="underline" href="#get-code">above</a>). Lost or retired a device? On <B>Account → Server</B>, click <B>Remove server</B>. That deletes its key and the others carry on. If the server is online and still runs accounts, you are asked to confirm first.</P>
            <P>Servers set up with the project's default Firebase key (older installs) are only removed from the list. Their key isn't revoked, since Nothing BOT Curate didn't make it.</P>
            <P><B>Fallback.</B> If a server can't use a code, make its key by hand on your own Mac (with the Google Cloud CLI signed in), from the project folder, and click <B>or drop a key file</B> in its console:</P>
            <Cmd>deploy/new-server-key.sh studio-mac</Cmd>
            <P>The key can only use the database, the login backups and push notifications, nothing else. To revoke one by hand:</P>
            <Cmd>deploy/revoke-server-key.sh studio-mac</Cmd>
            <P>Add <Code>--dry-run</Code> to either script to see what it would do without changing anything.</P>
            <P><B>Gemini-only servers.</B> A computer without room for Gemma (under about 8 GB of memory) can still be a server, and answers with Gemini instead. The installer picks that by itself on small computers. In the server console, <B>AI models → Local model on this computer</B> turns the local model on or off at any time, and you add a Gemini key right there (or each curator adds their own in the app). The default routing there (local first, Gemini first, Gemini only, local only) applies to curators who haven't chosen their own; anyone who has keeps their choice.</P>
            <P><B>What "Local only" means.</B> A curator who picks Local only never has their chats sent to Gemini. Only servers running Gemma can host that account, so a Gemini-only server will not take it. If no Gemma server is online, the account waits until one is. With the default, Local first, any server can host the account and Gemini answers when Gemma is down.</P>
            <Callout>Keep at least one server with Gemma if any curator uses Local only.</Callout>
          </Section>

          <Section id="primary" title="Make another server your primary">
            <Steps>
              <li><B>Move the accounts.</B> In <B>Account → Server → Fleet</B>, open the menu next to an account, pick <B>Move to</B> and choose the new server. Curators can do it under <B>Settings → WhatsApp &amp; app → Move to…</B>. WhatsApp reconnects in about a minute.</li>
              <li><B>Pin them.</B> Use <B>Pin to this server</B> (admins) or <B>Keep on this server</B> (curators) on the new server.</li>
            </Steps>
            <P><B>On failover:</B> if the pinned server goes offline, another server takes the account after about 150 seconds, with no new QR scan. <B>When it comes back:</B> the account is pulled back to the pinned server and WhatsApp reconnects again in about a minute. Unpin an account if you would rather it stay where it is.</P>
          </Section>

          <Section id="start-over" title="Starting over">
            <Steps>
              <li>On <B>Account → Server</B>, click <B>Remove server</B> on every server.</li>
              <li>Click <B>Add a server</B> and make a code.</li>
              <li>On a computer with Nothing BOT Server installed, open the console, enter the code and click <B>Join</B>. Repeat for each server.</li>
            </Steps>
            <Callout>Curators keep their data, and each account's login backup stays in the cloud, so the first server to join takes the accounts over without a new QR scan.</Callout>
          </Section>

          <Section id="everyday" title="Start, stop and restart">
            <P>From anywhere: in the app, <B>Account → Server</B> has <B>Restart</B> buttons for the worker and Ollama.</P>
            <P>On the server itself:</P>
            {os === "mac" && (
              <>
                <Table
                  head={["Do this", "How"]}
                  rows={[
                    ["Start / stop the server", <>The big <B>Start server</B> / <B>Stop server</B> button, or the 🎙 menu-bar icon</>],
                    ["Restart one part", <><B>More → Restart worker</B> or <B>Restart Ollama</B></>],
                    ["Close the window", "The server keeps running. Quit from the menu bar also leaves it running."],
                  ]}
                />
                <P>From Terminal, the same controls:</P>
                <Cmd>{`${MAC_CTL} status\n${MAC_CTL} stop\n${MAC_CTL} start\n${MAC_CTL} restart worker`}</Cmd>
              </>
            )}
            {os === "windows" && (
              <Table
                head={["Do this", "How"]}
                rows={[
                  ["Restart the worker", <>Double-click <B>Restart Worker.cmd</B> (in the folder you unzipped)</>],
                  ["Stop everything", <>PowerShell as admin: <Code>Stop-ScheduledTask NothingBotServerWorker</Code></>],
                  ["Start again", <><Code>Start-ScheduledTask NothingBotServerWorker</Code>, or just restart the PC</>],
                ]}
              />
            )}
            {os === "linux" && <Cmd>{"sudo systemctl status nothing-bot-server-worker\nsudo systemctl stop nothing-bot-server-worker\nsudo systemctl start nothing-bot-server-worker\nsudo systemctl restart nothing-bot-server-worker ollama"}</Cmd>}
            <Callout>Stopping is safe. WhatsApp closes cleanly and a backup of the login is saved. When you start again it reconnects without a QR, and reads (without auto-replying to) DMs from the last 3 days that arrived while it was off.</Callout>
          </Section>

          <Section id="always-on" title="Keep it always on">
            {os === "mac" && (
              <Bullets>
                <li>Turn on <B>Keep awake, even with the lid closed</B> in Nothing BOT Server (asks for your password once). Keep the Mac on power.</li>
                <li>Turn on <B>Start when I log in</B>.</li>
                <li>macOS runs the server only while you're logged in. For a Mac that restarts on its own, turn on <B>automatic login</B> in System Settings → Users & Groups.</li>
              </Bullets>
            )}
            {os === "windows" && (
              <Bullets>
                <li>The installer already turns off sleep on power and ignores the lid being closed.</li>
                <li>The server starts at boot, even before anyone logs in, and restarts itself if it crashes.</li>
                <li>Windows Update can restart the PC. That's fine: everything comes back by itself.</li>
              </Bullets>
            )}
            {os === "linux" && (
              <>
                <P>The installer ignores the lid and disables sleep. On a USB-stick install, also keep logs in memory and add swap:</P>
                <Cmd>{"sudo mkdir -p /etc/systemd/journald.conf.d\nprintf '[Journal]\\nStorage=volatile\\nRuntimeMaxUse=64M\\n' | sudo tee /etc/systemd/journald.conf.d/usb.conf\nsudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile\necho '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab"}</Cmd>
                <P>In the BIOS, put USB first in the boot order so the laptop boots the server stick.</P>
              </>
            )}
          </Section>

          <Section id="logs" title="Logs and health">
            <P>From anywhere: <B>Account → Server</B> in the app shows CPU, memory, disk, services, connected curators and the latest worker log.</P>
            {os === "mac" && <Cmd>{`tail -f ~/Library/Application\\ Support/NothingBotServer/logs/worker.log`}</Cmd>}
            {os === "windows" && <P>Double-click <B>View Logs.cmd</B>, or open <Code>C:\NothingBotServer\data\worker.log</Code>.</P>}
            {os === "linux" && <Cmd>journalctl -u nothing-bot-server-worker -f</Cmd>}
            <P>The console (port 7420) shows the same health, plus a live log and restart buttons.</P>
          </Section>

          <Section id="update" title="Update">
            <P>Servers update themselves. The console checks for a new release every 30 minutes and installs it a few minutes after it appears (each server waits a different few minutes, so a fleet doesn't restart at once). Turn that off under <B>Updates → Install updates automatically</B> in the console. <B>Update now</B> there, and the <B>Update</B> button on each server in <B>Account → Server</B>, do it immediately. The worker and console restart on the new code and WhatsApp reconnects within a minute; the download is checked against a published checksum first, and the local model is refreshed too.</P>
            <P>A server installed before automatic updates needs one manual update first. After that it takes care of itself:</P>
            {os === "mac" && <P>In Nothing BOT Server: <B>More → Update Nothing BOT Server</B>, or run the install command again.</P>}
            {os === "windows" && <P>Run <B>Install Nothing BOT Server.cmd</B> again from a freshly downloaded zip (or the PowerShell line above). It keeps your key, WhatsApp link and settings.</P>}
            {os === "linux" && <Cmd>curl -fsSL https://nothingbotcurating.web.app/install.sh | sudo bash</Cmd>}
            <P>Updates never touch your data, key or WhatsApp link.</P>
          </Section>

          <Section id="data" title="Your data and restarts">
            <Table
              head={["What", "Where it lives", "If the server stops or restarts"]}
              rows={[
                ["Shows, comics, requests, lineups, settings", "Cloud (Firebase)", "Untouched; the app keeps working"],
                ["WhatsApp link", "Server disk, backed up every 6 h and on stop", "Reconnects by itself, no QR"],
                ["Gemini key", "Cloud, write-only", "Untouched"],
                ["Firebase key, admins", "Server disk", "Untouched"],
                ["DMs while it was off", "WhatsApp", "Read on restart (last 3 days), no auto-replies"],
              ]}
            />
            <P>While the server is off, nothing is read or sent, and confirmations wait. If a power cut corrupts a WhatsApp link, the server restores the last backup automatically; only if that fails does it ask you to scan again, with an alert in the app.</P>
            <Callout tone="warn">WhatsApp unlinks devices that stay offline for a couple of weeks. Don't leave the server off for that long.</Callout>
          </Section>

          <Section id="troubleshooting" title="Troubleshooting">
            <Table
              head={["You see", "Try this"]}
              rows={[
                [<B>“Server offline” in the app</B>, os === "mac" ? "Open Nothing BOT Server and check it says Running; press Start server. Make sure the Mac is awake and online." : os === "windows" ? "Check the PC is on and online. Double-click Restart Worker.cmd, then View Logs.cmd." : "sudo systemctl status nothing-bot-server-worker; check the laptop is awake and online."],
                [<B>Show QR code does nothing</B>, "Wait a minute after starting; check the worker log for errors, then restart the worker."],
                [<B>Asked to scan again</B>, "Scan it. It happens after long phone downtime or a corrupted link the backup couldn't fix."],
                [<B>Server page empty</B>, "Your email isn't in Admins. Add it in the server console."],
                [<B>Something on the server looks wrong</B>, "In the server console, open Health and press Check and repair. Services has Stop and Start for the worker and for Ollama (a stopped Ollama stays stopped until you press Start)."],
                [<B>Replies are slow</B>, <>Switch to a smaller model (Settings → AI models, e.g. <Code>gemma3:1b</Code>) or add Gemini as primary or fallback.</>],
                [<B>New curator stuck on “Waiting for approval”</B>, "Approve them in Account → Server → Curators. Check the curator limit."],
                ...(os === "mac" ? [[<B>“Can't verify the developer”</B>, "System Settings → Privacy & Security → Open Anyway, or use the Terminal install."]] : []),
                ...(os === "linux" ? [[<B>Laptop won't boot the USB stick</B>, "BIOS: USB first in the boot order, Secure Boot off."]] : []),
              ]}
            />
          </Section>

          <Section id="uninstall" title="Uninstall">
            {os === "mac" && (
              <>
                <P>In Nothing BOT Server: <B>More → Uninstall</B>. It keeps your WhatsApp link and keys, so reinstalling picks up where you left off. To remove everything:</P>
                <Cmd>{`${MAC_CTL} uninstall --all`}</Cmd>
              </>
            )}
            {os === "windows" && <P>Double-click <B>Uninstall.cmd</B>. It removes the startup tasks, shortcuts, firewall rule and program files (and the same for an old Spot Solutions server), and keeps <Code>C:\NothingBotServer\data</Code>. To delete that folder too, run <Code>.\uninstall.ps1 -DeleteData</Code> in PowerShell as Administrator.</P>}
            {os === "linux" && <Cmd>{"curl -fsSL https://nothingbotcurating.web.app/uninstall.sh | sudo bash\n# keeps your data. To delete it too:\ncurl -fsSL https://nothingbotcurating.web.app/uninstall.sh | sudo bash -s -- --delete-data"}</Cmd>}
            <P>On your phone, also remove the old entry under <B>WhatsApp → Linked devices</B>.</P>
          </Section>

          <footer className="mt-6 flex flex-wrap items-center gap-3 rounded-xl bg-surface-low p-5">
            <IconServer className="icon size-6 text-primary" />
            <span className="flex-1 type-body-m text-on-surface-variant">Running into something not covered here? Check the worker log first; most problems name themselves there.</span>
            <IconCpu className="icon size-6 text-primary" />
          </footer>
        </main>
      </div>
    </div>
  );
}
