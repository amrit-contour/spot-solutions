// "Templates" button for any message box: your saved snippets plus the messages from Settings → Messages, filled in for
// this comic (or group) and dropped into the box to edit before sending.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { greetName, messageRich, messageType, renderRich, snippetRich, type MessageKey, type MessageKind, type RichMessage, type TemplateVars } from "@spot/shared";
import { useApp } from "../lib/app";
import { Menu, MenuItem } from "@spot/ui";
import { Button, FieldIconButton } from "@spot/ui";
import { IconTemplate } from "@spot/ui";
import { messageSummary } from "@spot/ui";

/** Messages worth sending by hand from a comic's chat. */
export const COMIC_MESSAGE_KEYS: MessageKey[] = ["statusConfirmed", "statusPencilled", "statusNone", "showInfo", "lastSpot", "cancelDone", "offerFull", "onboard"];

type Builtin = "ack" | "confirm" | "reject" | "cancelSpot";
const BUILTIN_LABEL: Record<Builtin, string> = { ack: "Got your request", confirm: "Spot confirmed", reject: "No spot this week", cancelSpot: "Taken off the lineup" };

/**
 * `kinds` limits the list to what this box can send (an offer can't send a bare pin, for one).
 * `messages` and `builtins` add templates from Settings; `name` is left out for groups (no {{name}} there).
 */
export function SnippetMenu({ name, vars, onPick, kinds, messages = [], builtins = [], trigger, toolbar }: { name?: string; vars?: TemplateVars; onPick: (m: RichMessage) => void; kinds?: MessageKind[]; messages?: MessageKey[]; builtins?: Builtin[]; /** Replaces the "Templates" button (the chat composer opens this from its + sheet). */ trigger?: (toggle: () => void, open: boolean) => ReactNode; /** An icon button for a message field's toolbar. */ toolbar?: boolean }) {
  const { settings } = useApp();
  const fill = { ...vars, ...(name !== undefined && { name: greetName(name) }) };
  const fits = (m: RichMessage) => !kinds || kinds.includes(m.kind);
  const snippets = (settings.snippets ?? []).filter((s) => fits(snippetRich(s)));
  const fromSettings = [
    ...builtins.map((b) => ({ id: b, label: BUILTIN_LABEL[b], msg: { kind: "text", body: settings[b].template, ...(b === "confirm" && settings.confirm.attachLocation && { attachLocation: true }) } as RichMessage })),
    ...messages.map((k) => ({ id: k, label: messageType(k).label, msg: messageRich(settings, k) })),
  ].filter((t) => fits(t.msg));
  const pick = (m: RichMessage, close: () => void) => {
    onPick(renderRich(m, fill));
    close();
  };
  return (
    <Menu
      align={toolbar ? "left" : "right"}
      trigger={(toggle, open) =>
        trigger ? trigger(toggle, open) : toolbar ? (
          <FieldIconButton label="Templates" active={open} aria-expanded={open} aria-haspopup="menu" onClick={toggle}>
            <IconTemplate className="icon size-5" />
          </FieldIconButton>
        ) : (
        <Button size="sm" variant="text" icon={IconTemplate} onClick={toggle} aria-expanded={open} aria-haspopup="menu">
          Templates
        </Button>
        )
      }
    >
      {(close) => (
        <div className="w-72">
          {fromSettings.length > 0 && <p className="px-4 pt-2 pb-1 type-label-m text-on-surface-variant">Your messages</p>}
          {fromSettings.map((t) => (
            <MenuItem key={t.id} onClick={() => pick(t.msg, close)}>
              <span className="block truncate">{t.label}</span>
              <span className="block truncate type-body-s text-on-surface-variant">{messageSummary(renderRich(t.msg, fill))}</span>
            </MenuItem>
          ))}
          {fromSettings.length > 0 && <p className="mt-1 border-t border-outline-variant/40 px-4 pt-2 pb-1 type-label-m text-on-surface-variant">Saved templates</p>}
          {snippets.map((s) => (
            <MenuItem key={s.id} onClick={() => pick(snippetRich(s), close)}>
              <span className="block truncate">{s.title || "Untitled"}</span>
              <span className="block truncate type-body-s text-on-surface-variant">{messageSummary(snippetRich(s))}</span>
            </MenuItem>
          ))}
          {!snippets.length && <p className="px-4 py-2 type-body-s text-on-surface-variant">No saved templates yet.</p>}
          <Link to="/settings?msg=snippets#messages" onClick={close} className="state-layer mt-1 flex min-h-11 items-center border-t border-outline-variant/40 px-4 type-label-l text-primary">
            Manage templates
          </Link>
        </div>
      )}
    </Menu>
  );
}
