// Keep the last few hundred log lines in memory so admins can read them from the app's Server page.
import { format } from "node:util";

const MAX = 200;
export const recentLogs: string[] = [];

function tap(level: "log" | "warn" | "error") {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    orig(...args);
    const line = format(...args).split("\n")[0].slice(0, 400);
    recentLogs.push(`${new Date().toISOString().slice(5, 19).replace("T", " ")} ${level === "log" ? "" : `${level.toUpperCase()} `}${line}`);
    if (recentLogs.length > MAX) recentLogs.splice(0, recentLogs.length - MAX);
  };
}
tap("log");
tap("warn");
tap("error");
