// "Templates" button for any reply box: drops one of the curator's saved snippets in, filled for this comic.
import { Link } from "react-router-dom";
import { greetName, renderTemplate, type TemplateVars } from "@spot/shared";
import { useApp } from "../lib/app";
import { Menu, MenuItem } from "./Menu";
import { Button } from "./ui";
import { IconTemplate } from "./icons";

export function SnippetMenu({ name, vars, onPick }: { name: string; vars?: TemplateVars; onPick: (text: string) => void }) {
  const { settings } = useApp();
  const snippets = settings.snippets ?? [];
  return (
    <Menu
      align="right"
      trigger={(toggle, open) => (
        <Button size="sm" variant="text" icon={IconTemplate} onClick={toggle} aria-expanded={open} aria-haspopup="menu">
          Templates
        </Button>
      )}
    >
      {(close) => (
        <div className="w-72">
          {snippets.map((s) => (
            <MenuItem
              key={s.id}
              onClick={() => {
                onPick(renderTemplate(s.body, { ...vars, name: greetName(name) }));
                close();
              }}
            >
              <span className="block truncate">{s.title || "Untitled"}</span>
              <span className="block truncate type-body-s text-on-surface-variant">{s.body}</span>
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
