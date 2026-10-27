import { useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { DEFAULT_SETTINGS, RosterFormatError, fromCsv, fromRosterJson, groupByArea, localDate, roomMatches, toCsv, toRosterJson, type Room } from "@spot/shared";
import { Button, CompactButton, Empty, IconAdd, IconBuilding, IconImport, IconMenuDots, IconButton, IconSearch, Menu, MenuItem, PageHeader, Segmented, Spinner, TextInput } from "@spot/ui";
import { useRoster } from "../lib/roster";
import { blankRoom } from "../lib/rooms";
import { downloadText } from "../lib/files";
import { RoomCard } from "../components/RoomCard";
import { RoomEditor } from "../components/RoomEditor";
import { CuratorsPanel } from "../components/CuratorsPanel";
import { ImportSheet, type Incoming } from "../components/ImportSheet";
import { PasteImportSheet } from "../components/PasteImportSheet";

const TZ = DEFAULT_SETTINGS.timezone;

/** Starter data has made-up numbers. They are dropped on the way in, so no real person is ever messaged by mistake. */
async function loadStarter(): Promise<Incoming> {
  const { buildBlrRoster } = await import("@spot/shared/fixtures/blrRooms");
  const roster = buildBlrRoster();
  let stripped = 0;
  roster.curators = roster.curators.map((c) => {
    if (!c.phone) return c;
    stripped++;
    const { phone: _p, ...rest } = c;
    return { ...rest, notes: "Add their real number" };
  });
  return {
    roster,
    source: "Bangalore starter",
    warning: `A starting point built from a public mic list, so check it. ${stripped} placeholder phone number${stripped === 1 ? " was" : "s were"} left out: add the real ones on the Curators tab.`,
  };
}

/** Rooms and Curators. `base` is where this page is mounted ("/rooms"), so the Curators tab is `${base}/curators`. */
export function Rooms({ base = "/rooms" }: { base?: string }) {
  const store = useRoster();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const tab = pathname.replace(/\/$/, "").endsWith("/curators") ? "curators" : "rooms";
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Room | null>(null);
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  const [pasting, setPasting] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const date = localDate(new Date(), TZ);

  const shown = useMemo(() => groupByArea(store.rooms.filter((r) => roomMatches(r, store.curators, q))), [store.rooms, store.curators, q]);
  const startNew = () => setEditing(blankRoom(store.rooms[0]?.city ?? "Bengaluru"));

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const text = await f.text();
      const isJson = /\.json$/i.test(f.name) || text.trimStart().startsWith("{");
      const roster = isJson ? fromRosterJson(text).roster : fromCsv(text);
      if (roster.rooms.length === 0) return toast.error("That file has no rooms in it.");
      setIncoming({ roster, source: f.name });
    } catch (e) {
      toast.error(e instanceof RosterFormatError ? e.message : "Couldn't read that file. Use a roster JSON or CSV.");
    } finally {
      if (file.current) file.current.value = "";
    }
  };

  const exportAs = (kind: "json" | "backup" | "csv") => {
    const roster = { rooms: store.rooms, curators: store.curators };
    if (!roster.rooms.length) return toast.error("Add a room first. There's nothing to export yet.");
    const stamp = date;
    if (kind === "csv") downloadText(`nothing-bot-rooms-${stamp}.csv`, toCsv(roster), "text/csv");
    else downloadText(`nothing-bot-rooms-${stamp}${kind === "backup" ? "-backup" : ""}.json`, toRosterJson(roster, { exportedAt: Date.now(), full: kind === "backup" }), "application/json");
  };

  const starter = async () => setIncoming(await loadStarter());

  const empty = !store.loading && store.rooms.length === 0;
  return (
    <div className="w-full">
      <PageHeader
        title="Rooms"
        actions={
          <>
            <CompactButton icon={IconAdd} label="Add a room" variant="filled" onClick={startNew} />
            <Menu align="right" trigger={(open) => <IconButton icon={IconMenuDots} label="Import and export" onClick={open} />}>
              {(close) => (
                <>
                  <MenuItem onClick={() => { close(); file.current?.click(); }}>Import a file</MenuItem>
                  <MenuItem onClick={() => { close(); setPasting(true); }}>Import from text, file or link…</MenuItem>
                  <MenuItem onClick={() => { close(); void starter(); }}>Load the Bangalore starter</MenuItem>
                  <MenuItem onClick={() => { close(); exportAs("json"); }} hint="JSON">Export to share</MenuItem>
                  <MenuItem onClick={() => { close(); exportAs("csv"); }} hint="CSV">Export a spreadsheet</MenuItem>
                  <MenuItem onClick={() => { close(); exportAs("backup"); }} hint="JSON">Export a backup</MenuItem>
                </>
              )}
            </Menu>
          </>
        }
      >
        <div className="relative mt-3">
          <IconSearch aria-hidden className="icon pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-on-surface-variant" />
          <TextInput value={q} onChange={(e) => setQ(e.target.value)} className="pl-11" placeholder={tab === "rooms" ? "Search rooms, areas, curators" : "Search curators"} type="search" aria-label="Search" />
        </div>
      </PageHeader>
      <input ref={file} type="file" accept=".json,.csv,application/json,text/csv" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />

      <div className="px-4 pt-3 pb-4 sm:px-8">
        <Segmented value={tab} onChange={(t) => nav(t === "rooms" ? base : `${base}/curators`)} options={[{ value: "rooms", label: "Rooms" }, { value: "curators", label: "Curators" }]} />
      </div>

      {tab === "curators" ? (
        <CuratorsPanel q={q} />
      ) : store.loading ? (
        <div className="grid place-items-center py-16 text-primary"><Spinner className="size-8" /></div>
      ) : empty ? (
        <Empty
          icon={IconBuilding}
          title="No rooms yet"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button icon={IconAdd} onClick={startNew}>Add a room</Button>
              <Button variant="tonal" icon={IconImport} onClick={() => file.current?.click()}>Import</Button>
              <Button variant="outlined" onClick={() => void starter()}>Load the Bangalore starter</Button>
            </div>
          }
        >
          Add the mics you go to, or import a roster file. New here in Bangalore? The starter has the city's mics to begin with.
        </Empty>
      ) : shown.length === 0 ? (
        <Empty icon={IconSearch} title="No rooms match">Try a different name, area or curator.</Empty>
      ) : (
        <div className="flex min-w-0 flex-col gap-8 px-4 pb-[calc(var(--nav-h)+2rem)] sm:px-8 sm:pb-12">
          {shown.map((g) => (
            <section key={g.area || "none"} aria-label={g.area || "No area"} className="min-w-0">
              <h2 className="mb-3 flex items-baseline gap-2 type-title-m text-on-surface-variant">
                <span className="min-w-0 truncate">{g.area || "No area"}</span>
                <span className="type-label-m tabular">{g.rooms.length}</span>
              </h2>
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
                {g.rooms.map((r) => (
                  <li key={r.id} className="min-w-0">
                    <RoomCard room={r} curators={store.curators} date={date} onOpen={() => setEditing(r)} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <RoomEditor value={editing} onClose={() => setEditing(null)} />
      <PasteImportSheet open={pasting} onClose={() => setPasting(false)} city={store.rooms[0]?.city ?? "Bengaluru"} onParsed={(p) => setIncoming(p)} />
      <ImportSheet incoming={incoming} onClose={() => setIncoming(null)} />
    </div>
  );
}
