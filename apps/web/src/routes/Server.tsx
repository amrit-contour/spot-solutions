import { useEffect, useState } from "react";
import { addDoc, collection, onSnapshot, query, where } from "firebase/firestore";
import { toast } from "sonner";
import { motion } from "motion/react";
import type { ServerStatus } from "@spot/shared";
import { useApp } from "../lib/app";
import { db } from "../lib/firebase";
import { timeAgo, useNow } from "../lib/data";
import { PageHeader } from "../components/Shell";
import { Curators } from "../components/Curators";
import { isAdmin, useAccessConfig } from "../lib/access";
import { Avatar, Button, Card, Chip, Empty, cx } from "../components/ui";
import { IconCheck, IconCpu, IconRefresh, IconServer, IconWarn } from "../components/icons";

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
      <span className={cx("size-2.5 flex-none rounded-full", up ? "bg-[#3fb950]" : "bg-error")} />
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
      const ref = await addDoc(collection(db, "servers", serverId, "commands"), { type, status: "pending", by: user.email ?? user.uid, createdAt: Date.now() });
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
    <Button size="sm" variant="tonal" icon={IconRefresh} loading={busy} disabled={disabled} onClick={go}>
      {label}
    </Button>
  );
}

function ServerCard({ s }: { s: ServerStatus }) {
  const now = useNow(5_000);
  const online = now - s.lastSeen < ONLINE_MS;
  const linked = s.sessions.filter((x) => x.status === "ready").length;
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className={cx("grid size-12 place-items-center rounded-md", online ? "bg-primary-container text-on-primary-container" : "bg-error-container text-on-error-container")}>
          <IconServer className="icon size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate type-title-l">{s.hostname}</h2>
          <p className="type-body-s text-on-surface-variant">
            {s.osRelease} · {s.arch} · v{s.version}
          </p>
        </div>
        <Chip tone={online ? "success" : "error"} icon={online ? IconCheck : IconWarn}>
          {online ? `Online · up ${fmtUptime(now - s.startedAt)}` : `Offline · last seen ${timeAgo(s.lastSeen, now)}`}
        </Chip>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="flex flex-col gap-4 p-5">
          <Meter label="CPU" used={s.cpu.usage} total={1} detail={`${Math.round(s.cpu.usage * 100)}% · ${s.cpu.cores} cores · load ${s.cpu.load1.toFixed(2)}`} />
          <Meter label="Memory" used={s.memory.total - s.memory.free} total={s.memory.total} detail={`${fmtBytes(s.memory.total - s.memory.free)} of ${fmtBytes(s.memory.total)} · worker ${fmtBytes(s.memory.process)}`} />
          {s.disk && <Meter label="Disk" used={s.disk.total - s.disk.free} total={s.disk.total} detail={`${fmtBytes(s.disk.free)} free of ${fmtBytes(s.disk.total)}`} />}
          <p className="truncate type-body-s text-on-surface-variant" title={s.cpu.model}>
            {s.cpu.model}
          </p>
        </Card>

        <Card className="overflow-hidden">
          <h3 className="px-4 pt-4 pb-1 type-title-s">Services</h3>
          <ul className="divide-y divide-outline-variant/40">
            <Service name="Spot Solutions worker" up={online} detail={online ? `Heartbeat ${timeAgo(s.lastSeen, now)}` : undefined} action={<RestartButton serverId={s.id} type="restart_worker" label="Restart" disabled={!online} />} />
            <Service name="Ollama" up={online && s.ollama.up} action={<RestartButton serverId={s.id} type="restart_ollama" label="Restart" disabled={!online} />} detail={s.ollama.up ? `${s.ollama.models.length} model${s.ollama.models.length === 1 ? "" : "s"}${s.ollama.loaded.length ? ` · ${s.ollama.loaded.join(", ")} loaded` : ""}` : undefined} />
            <Service name="WhatsApp sessions" up={online && linked > 0} detail={`${linked} linked of ${s.sessions.length}`} />
            <Service name="Server Gemini key" up={s.geminiServerKey} detail={s.geminiServerKey ? "Set (used when a curator has none)" : "Not set (curators use their own)"} />
          </ul>
        </Card>
      </div>

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

      <Card className="overflow-hidden">
        <h3 className="px-4 pt-4 pb-1 type-title-s">Connected curators</h3>
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
      </Card>

      {s.logs && s.logs.length > 0 && (
        <Card className="overflow-hidden">
          <div className="flex items-baseline justify-between px-4 pt-4 pb-2">
            <h3 className="type-title-s">Worker log</h3>
            <span className="type-body-s text-on-surface-variant">updates every 30 s</span>
          </div>
          <pre className="max-h-80 overflow-auto bg-surface-container px-4 py-3 font-mono text-xs leading-5 whitespace-pre-wrap text-on-surface-variant" ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}>
            {s.logs.join("\n")}
          </pre>
        </Card>
      )}

      {s.ollama.models.length > 0 && (
        <Card className="p-4">
          <h3 className="mb-2 flex items-center gap-2 type-title-s">
            <IconCpu className="icon size-5 text-primary" /> Local models
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {s.ollama.models.map((m) => (
              <Chip key={m.name} tone={s.ollama.loaded.includes(m.name) ? "primary" : "neutral"}>
                <span className="font-mono">{m.name}</span> <span className="opacity-70">· {fmtBytes(m.size)}</span>
              </Chip>
            ))}
          </div>
        </Card>
      )}
    </section>
  );
}

export function ServerPage() {
  const servers = useServers();
  const { user } = useApp();
  const admin = isAdmin(useAccessConfig(), user.email);
  return (
    <div className="w-full">
      <PageHeader title="Server" subtitle="Health of the machines running Spot Solutions" />
      <div className="flex flex-col gap-10 px-4 pb-12 sm:px-8">
        {admin && <Curators />}
        {servers === null ? null : servers.length ? (
          servers.map((s) => <ServerCard key={s.id} s={s} />)
        ) : (
          <Empty icon={IconServer} title="No server reporting to you">
            Servers show up here when their install lists your email as an admin. Add it once in the server console (port 7420, on the server's own network); after that you can manage it from here, anywhere.
          </Empty>
        )}
      </div>
    </div>
  );
}
