import { useEffect, useState } from "react";
import { addDoc, collection, doc, onSnapshot, query, updateDoc, where } from "firebase/firestore";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import { motion } from "motion/react";
import { TTL_DAYS, type ServerStatus } from "@spot/shared";
import { useApp } from "../lib/app";
import { db } from "@spot/ui/firebase";
import { expireAt, timeAgo, useNow } from "../lib/data";
import { PageHeader } from "@spot/ui";
import { Curators } from "../components/Curators";
import { FleetView } from "../components/FleetView";
import { Collapsible } from "@spot/ui";
import { AddServerCard } from "../components/AddServerCard";
import { Menu, MenuItem } from "@spot/ui";
import { RemoveServerButton } from "../components/RemoveServerButton";
import { ServerUpdate } from "../components/ServerUpdate";
import { WipeDemoCard } from "../components/AdminDataTools";
import { isAdmin, useAccessConfig } from "../lib/access";
import { Avatar, Card, Chip, CompactButton, Empty, cx } from "@spot/ui";
import { IconComics, IconCpu, IconLightbulb, IconRefresh, IconServer } from "@spot/ui";

const ONLINE_MS = 90_000;

/** Servers that list this user's email as an admin. */
export function useServers() {
  const { user } = useApp();
  const [servers, setServers] = useState<ServerStatus[] | null>(null);
  const email = user.email?.toLowerCase();
  useEffect(() => {
    if (!email) return setServers([]);
    return onSnapshot(
      query(collection(db, "servers"), where("admins", "array-contains", email)),
      (q) => setServers(q.docs.map((d) => d.data() as ServerStatus)),
      () => setServers([]),
    );
  }, [email]);
  return servers;
}

const fmtBytes = (b: number) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
function fmtUptime(ms: number) {
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
}

function Meter({ label, used, total, detail }: { label: string; used: number; total: number; detail: string }) {
  const pct = total ? Math.min(1, used / total) : 0;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="type-label-l">{label}</span>
        <span className="type-body-s text-on-surface-variant tabular">{detail}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-highest">
        <motion.div className={cx("h-full rounded-full", pct > 0.9 ? "bg-error" : pct > 0.75 ? "bg-tertiary" : "bg-primary")} initial={{ width: 0 }} animate={{ width: `${pct * 100}%` }} transition={{ type: "spring", duration: 0.6, bounce: 0 }} />
      </div>
    </div>
  );
}

function Service({ name, up, detail, action }: { name: string; up: boolean; detail?: string; action?: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span className={cx("size-2.5 flex-none rounded-full", up ? "bg-ok" : "bg-error")} />
      <div className="min-w-0 flex-1">
        <div className="type-body-l">{name}</div>
        <div className="truncate type-body-s text-on-surface-variant">{detail ?? (up ? "Running" : "Down")}</div>
      </div>
      {action}
    </li>
  );
}

function RestartButton({ serverId, type, label, disabled }: { serverId: string; type: "restart_worker" | "restart_ollama"; label: string; disabled?: boolean }) {
  const { user } = useApp();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (type === "restart_worker" && !confirm("Restart the worker? WhatsApp reconnects by itself in about a minute.")) return;
    setBusy(true);
    try {
      const ref = await addDoc(collection(db, "servers", serverId, "commands"), { type, status: "pending", by: user.email ?? user.uid, createdAt: Date.now(), expireAt: expireAt(TTL_DAYS.commands) });
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => (unsub(), reject(new Error("The server didn't respond"))), 90_000);
        const unsub = onSnapshot(ref, (d) => {
          const st = d.data()?.status;
          if (st === "done") (clearTimeout(t), unsub(), resolve());
          if (st === "error") (clearTimeout(t), unsub(), reject(new Error(d.data()?.error ?? "Failed")));
        });
      });
      toast.success(type === "restart_worker" ? "Worker restarting. It'll be back in a minute." : "Ollama restarted");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <CompactButton icon={IconRefresh} label={label} loading={busy} disabled={disabled} onClick={go} />
  );
}

function ServerCard({ s }: { s: ServerStatus }) {
  const now = useNow(5_000);
  const online = now - s.lastSeen < ONLINE_MS;
  const linked = s.sessions.filter((x) => x.status === "ready").length;

  // The worker sends its log only while someone is watching: say so while the log section is open, and keep saying it.
  const [logsOpen, setLogsOpen] = useState(false);
  useEffect(() => {
    if (!logsOpen) return;
    const ping = () => void updateDoc(doc(db, "servers", s.id), { logsWanted: Date.now() }).catch(() => undefined);
    ping();
    const t = setInterval(ping, 60_000);
    return () => clearInterval(t);
  }, [logsOpen, s.id]);

  return (
    <Collapsible
      id={`server:${s.id}`}
      plain
      icon={IconServer}
      title={s.hostname}
      subtitle={`${s.osRelease} · ${s.arch} · v${s.version}`}
      summary={online ? `Online · up ${fmtUptime(now - s.startedAt)}` : `Offline · last seen ${timeAgo(s.lastSeen, now)}`}
      summaryTone={online ? "success" : "error"}
    >
      <div className="flex flex-col gap-4 pb-1">
      <div className="flex flex-wrap items-center justify-end gap-2 empty:hidden">
        <ServerUpdate server={s} online={online} now={now} />
        <ConsoleLinks server={s} />
        <RemoveServerButton server={s} />
      </div>

      <Collapsible id={`server:${s.id}:health`} title="Health and services" icon={IconCpu} summary={online ? `${Math.round(s.cpu.usage * 100)}% CPU` : "Offline"} summaryTone={online ? "neutral" : "error"}>
      <div className="grid gap-4 px-4 pb-4 md:grid-cols-2">
        <Card tone="container" className="flex flex-col gap-4 p-5">
          <Meter label="CPU" used={s.cpu.usage} total={1} detail={`${Math.round(s.cpu.usage * 100)}% · ${s.cpu.cores} cores · load ${s.cpu.load1.toFixed(2)}`} />
          <Meter label="Memory" used={s.memory.total - s.memory.free} total={s.memory.total} detail={`${fmtBytes(s.memory.total - s.memory.free)} of ${fmtBytes(s.memory.total)} · worker ${fmtBytes(s.memory.process)}`} />
          {s.disk && <Meter label="Disk" used={s.disk.total - s.disk.free} total={s.disk.total} detail={`${fmtBytes(s.disk.free)} free of ${fmtBytes(s.disk.total)}`} />}
          <p className="truncate type-body-s text-on-surface-variant" title={s.cpu.model}>
            {s.cpu.model}
          </p>
        </Card>

        <Card tone="container" className="overflow-hidden">
          <h3 className="px-4 pt-4 pb-1 type-title-s">Services</h3>
          <ul className="divide-y divide-outline-variant/40">
            <Service name="Nothing BOT worker" up={online} detail={online ? `Heartbeat ${timeAgo(s.lastSeen, now)}` : undefined} action={<RestartButton serverId={s.id} type="restart_worker" label="Restart" disabled={!online} />} />
            <Service name="Ollama" up={online && s.ollama.up} action={<RestartButton serverId={s.id} type="restart_ollama" label="Restart" disabled={!online} />} detail={s.ollama.up ? `${s.ollama.models.length} model${s.ollama.models.length === 1 ? "" : "s"}${s.ollama.loaded.length ? ` · ${s.ollama.loaded.join(", ")} loaded` : ""}` : undefined} />
            <Service name="WhatsApp sessions" up={online && linked > 0} detail={`${linked} linked of ${s.sessions.length}`} />
            <Service name="Server Gemini key" up={s.geminiServerKey} detail={s.geminiServerKey ? "Set (used when a curator has none)" : "Not set (curators use their own)"} />
          </ul>
        </Card>
      </div>
      </Collapsible>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Messages in", s.counters.messagesIn],
          ["AI calls", s.counters.classified],
          ["Messages sent", s.counters.sent],
          ["Errors", s.counters.errors],
        ].map(([l, n]) => (
          <Card key={l} tone="container" className="px-4 py-3">
            <div className={cx("type-headline-m tabular", l === "Errors" && Number(n) > 0 && "text-error")}>{n}</div>
            <div className="type-label-m text-on-surface-variant">{l} since start</div>
          </Card>
        ))}
      </div>

      {s.live && (
        <div className="type-label-m text-on-surface-variant">
          Last 24 h: {s.live.in24h} read · {s.live.spot24h} spot requests · {s.live.sent24h} sent · {s.live.err24h} errors · {s.live.ready} of {s.live.accounts} accounts connected{s.live.queue ? ` · ${s.live.queue} waiting to send` : ""}
        </div>
      )}

      <Collapsible id={`server:${s.id}:curators`} title="Connected curators" icon={IconComics} summary={`${linked} linked`} summaryTone={linked ? "success" : "neutral"}>
        <ul className="divide-y divide-outline-variant/40">
          {s.sessions.map((x) => (
            <li key={x.uid} className="flex items-center gap-3 px-4 py-3">
              <Avatar name={x.name ?? x.email ?? "?"} size={36} />
              <div className="min-w-0 flex-1">
                <div className="truncate type-body-l">{x.name ?? "Unnamed"}</div>
                <div className="truncate type-body-s text-on-surface-variant">
                  {x.email ?? x.uid}
                  {x.phone && ` · WhatsApp ${x.phone}`}
                </div>
              </div>
              <Chip tone={x.status === "ready" ? "success" : x.status === "qr" || x.status === "starting" ? "primary" : "neutral"}>{x.status === "ready" ? "Linked" : x.status === "qr" ? "Waiting for QR" : x.status}</Chip>
            </li>
          ))}
          {!s.sessions.length && <li className="px-4 py-4 type-body-s text-on-surface-variant">No curators yet.</li>}
        </ul>
      </Collapsible>

      <Collapsible id={`server:${s.id}:logs`} title="Worker log" icon={IconCpu} summary={logsOpen ? "Live" : "Off"} summaryTone={logsOpen ? "primary" : "neutral"} defaultOpen={false} persist={false} onOpenChange={setLogsOpen}>
        <div className="flex items-baseline justify-between px-4 pb-2">
          <p className="type-body-s text-on-surface-variant">Sent only while this is open, and updates every 30 s.</p>
        </div>
        {s.logs && s.logs.length > 0 ? (
          <pre className="max-h-80 overflow-auto bg-surface-container px-4 py-3 font-mono text-xs leading-5 whitespace-pre-wrap text-on-surface-variant" ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}>
            {s.logs.join("\n")}
          </pre>
        ) : (
          <p className="bg-surface-container px-4 py-3 type-body-s text-on-surface-variant">{online ? "Asking the server for its log. This can take up to 30 seconds." : "The server is offline, so there is no log to show."}</p>
        )}
      </Collapsible>

      {s.ollama.models.length > 0 && (
        <Collapsible id={`server:${s.id}:models`} title="Local models" icon={IconCpu} summary={`${s.ollama.models.length}`}>
          <div className="flex flex-wrap gap-2 border-t border-outline-variant/40 px-4 pt-3.5 pb-4">
            {s.ollama.models.map((m) => (
              <Chip key={m.name} tone={s.ollama.loaded.includes(m.name) ? "primary" : "neutral"}>
                <span className="font-mono">{m.name}</span> <span className="opacity-70">· {fmtBytes(m.size)}</span>
              </Chip>
            ))}
          </div>
        </Collapsible>
      )}
      </div>
    </Collapsible>
  );
}

export function ServerPage() {
  const servers = useServers();
  const { user } = useApp();
  const admin = isAdmin(useAccessConfig(), user.email);
  return (
    <div className="w-full">
      <PageHeader title="Server" subtitle="Health of the machines running Nothing BOT Server" trailing={admin ? <Link to="/help" aria-label="Server guide" title="Server guide" className="state-layer inline-flex h-10 items-center gap-2 rounded-full border border-outline-variant px-3 type-label-l text-on-surface-variant sm:px-4"><IconLightbulb className="icon size-5" /><span className="max-sm:hidden">Server guide</span></Link> : undefined} />
      <div className="flex flex-col gap-10 px-4 pb-12 sm:px-8">
        {admin && <AddServerCard />}
        {admin && <FleetView servers={servers} />}
        {admin && <Curators servers={servers} />}
        {admin && <WipeDemoCard servers={servers} />}
        {servers === null ? null : servers.length ? (
          servers.map((s) => <ServerCard key={s.id} s={s} />)
        ) : (
          <Empty icon={IconServer} title="No server reporting to you">
            Servers show up here when their install lists your email as an admin. Add it once in the server console (port 7420, on the server's own network); after that you can manage it from here, anywhere. <Link className="text-primary underline-offset-4 hover:underline" to="/help">Server guide</Link>
          </Empty>
        )}
      </div>
    </div>
  );
}


/** Links to the server's own console. They only work on that server's Wi-Fi: consoles never face the internet. */
function ConsoleLinks({ server }: { server: ServerStatus }) {
  const c = server.console;
  if (!c) return null;
  const q = c.token ? `/?token=${encodeURIComponent(c.token)}` : "/";
  const links = [c.host, ...c.ips].map((h) => ({ label: h, href: `http://${h}:${c.port}${q}` }));
  return (
    <Menu
      align="right"
      trigger={(open) => (
        <CompactButton icon={IconServer} label="Open console" onClick={open} title="Works when you're on the same Wi-Fi as this server" />
      )}
    >
      {(close) => (
        <>
          <div className="px-4 pt-2 pb-1 type-label-s text-on-surface-variant">On the same Wi-Fi as {server.hostname}</div>
          {links.map((l) => (
            <MenuItem key={l.href} onClick={() => (close(), window.open(l.href, "_blank", "noopener"))}>
              <span className="mono">{l.label}</span>
            </MenuItem>
          ))}
        </>
      )}
    </Menu>
  );
}
