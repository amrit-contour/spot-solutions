import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { DEFAULT_SETTINGS, groupByArea, localDate, roomMatches, type Room } from "@spot/shared";
import { Button, CompactButton, IconPlus, IconRoom, IconImport, IconMenuDots, IconButton, IconSearch, Menu, MenuItem, PageHeader, Segmented, Spinner } from "@spot/ui";
import { EmptyState, Page, SearchField, Section } from "../components/ui";
import { useRoster } from "../lib/roster";
import { blankRoom } from "../lib/rooms";
import { RoomCard } from "../components/RoomCard";
import { RoomEditor } from "../components/RoomEditor";
import { CuratorsPanel } from "../components/CuratorsPanel";
import { ImportSheet, type Incoming } from "../components/ImportSheet";
import { PublishSheet } from "../components/rosters/PublishSheet";
import { ShareSheet } from "../components/rosters/ShareSheet";
import { useCommunity } from "../lib/rosters";
import { PasteImportSheet } from "../components/PasteImportSheet";
import { ExportSheet } from "../components/ExportSheet";

const TZ = DEFAULT_SETTINGS.timezone;

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
  const [publishing, setPublishing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const community = useCommunity();
  const [exporting, setExporting] = useState(false);
  const date = localDate(new Date(), TZ);

  const shown = useMemo(() => groupByArea(store.rooms.filter((r) => roomMatches(r, store.curators, q))), [store.rooms, store.curators, q]);
  const startNew = () => setEditing(blankRoom(store.rooms[0]?.city ?? "Bengaluru"));

  const empty = !store.loading && store.rooms.length === 0;
  return (
    <div className="w-full">
      <PageHeader
        width="narrow"
        title="Rooms"
        actions={
          <>
            {tab === "rooms" && <CompactButton icon={IconPlus} label="Add a room" variant="filled" onClick={startNew} />}
            <Menu align="right" trigger={(open) => <IconButton icon={IconMenuDots} label="Import and export" onClick={open} />}>
              {(close) => (
                <>
                  <MenuItem onClick={() => { close(); setPasting(true); }}>Import…</MenuItem>
                  <MenuItem onClick={() => { close(); setExporting(true); }}>Export…</MenuItem>
                  {community.allowed && <MenuItem onClick={() => { close(); setSharing(true); }}>Share with someone…</MenuItem>}
                  {community.canPublish && <MenuItem onClick={() => { close(); setPublishing(true); }}>Publish…</MenuItem>}
                </>
              )}
            </Menu>
          </>
        }
        bar={
          <Segmented
            full
            size="sm"
            value={tab}
            onChange={(t) => nav(t === "rooms" ? base : t === "community" ? "/rosters" : `${base}/curators`)}
            options={[{ value: "rooms", label: "Rooms" }, { value: "curators", label: "Curators" }, ...(community.allowed ? [{ value: "community" as const, label: "Community" }] : [])]}
          />
        }
      />

      <Page>
        {(tab === "curators" || !empty) && <SearchField value={q} onChange={setQ} placeholder={tab === "rooms" ? "Search rooms, areas, curators" : "Search curators"} />}
        {tab === "curators" ? (
          <CuratorsPanel q={q} />
        ) : store.loading ? (
          <div className="grid place-items-center py-16 text-primary"><Spinner className="size-8" /></div>
        ) : empty ? (
          <EmptyState
            icon={IconRoom}
            title="No rooms yet"
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button icon={IconPlus} onClick={startNew}>Add a room</Button>
                <Button variant="tonal" icon={IconImport} onClick={() => setPasting(true)}>Import</Button>
              </div>
            }
          >
            Add the mics you go to, or import a list, a roster file or a link.
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState icon={IconSearch} title="No rooms match">Try a different name, area or curator.</EmptyState>
        ) : (
          shown.map((g) => (
            <Section key={g.area || "none"} title={g.area || "No area"} count={g.rooms.length}>
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
                {g.rooms.map((r) => (
                  <li key={r.id} className="min-w-0">
                    <RoomCard room={r} curators={store.curators} date={date} onOpen={() => setEditing(r)} />
                  </li>
                ))}
              </ul>
            </Section>
          ))
        )}
      </Page>

      <RoomEditor value={editing} onClose={() => setEditing(null)} />
      <PasteImportSheet open={pasting} onClose={() => setPasting(false)} city={store.rooms[0]?.city ?? "Bengaluru"} onParsed={(p) => setIncoming(p)} />
      {community.user && <ShareSheet open={sharing} onClose={() => setSharing(false)} user={community.user} />}
      {community.user && <PublishSheet open={publishing} onClose={() => setPublishing(false)} user={community.user} />}
      <ExportSheet open={exporting} onClose={() => setExporting(false)} roster={{ rooms: store.rooms, curators: store.curators }} stamp={date} />
      <ImportSheet incoming={incoming} onClose={() => setIncoming(null)} />
    </div>
  );
}
