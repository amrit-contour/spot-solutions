// A notice from the server: moved servers, a scan needed, catch-up summaries and warnings.
import { Link } from "react-router-dom";
import type { AppNotice } from "@spot/shared";
import { useApp } from "../../lib/app";
import { timeAgo } from "../../lib/data";
import { dismissNotice } from "../../lib/updates";
import { buttonClass, cx, IconButton } from "@spot/ui";
import { WaText } from "@spot/ui";
import { IconClose, IconHistory, IconWarn } from "@spot/ui";
import { UpdateItem } from "./shared";

/** A notice that points at a fix gets one obvious button for it. */
function fix(text: string): { to: string; label: string } | null {
  if (/Show QR code|link(ed)? again|WhatsApp login/i.test(text)) return { to: "/settings#whatsapp", label: "Open Settings" };
  if (/asked to use Nothing BOT Curate/i.test(text)) return { to: "/server", label: "Open Server" };
  return null;
}

export function ServerCard({ n }: { n: AppNotice }) {
  const { uid } = useApp();
  const warn = n.level === "warn";
  const link = n.link ? { to: n.link, label: n.linkLabel ?? "Open" } : fix(n.text);
  return (
    <UpdateItem className={warn ? "bg-error-container text-on-error-container" : "bg-surface-container"} onDismiss={() => dismissNotice(uid, n)}>
      <div className="flex items-start gap-3 py-3 pr-2 pl-4">
        {warn ? <IconWarn className="icon mt-0.5 size-5 flex-none" /> : <IconHistory className="icon mt-0.5 size-5 flex-none text-primary" />}
        <div className="min-w-0 flex-1">
          <WaText className="type-body-m [overflow-wrap:anywhere]" text={n.text} />
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className={cx("type-label-m tabular", warn ? "opacity-80" : "text-on-surface-variant")}>{timeAgo(n.createdAt)}</span>
            {link && (
              <Link to={link.to} data-primary className={buttonClass({ size: "sm", variant: warn ? "outlined" : "tonal" })}>
                {link.label}
              </Link>
            )}
          </div>
        </div>
        <IconButton icon={IconClose} label="Dismiss" className="size-9 flex-none self-center" onClick={() => dismissNotice(uid, n)} data-primary={link ? undefined : true} />
      </div>
    </UpdateItem>
  );
}
