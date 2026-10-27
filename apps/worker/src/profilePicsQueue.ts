// The queue behind profile pictures: one WhatsApp lookup per interval, nothing for Never read people, "none" remembered for
// hidden photos. No WhatsApp or Firestore in here (they come in as `deps`), so the rules are tested with fakes.
import { PHOTO_BATCH_MAX, PHOTO_INTERVAL_MS, PHOTO_NONE, photoDue, type PhotoFields } from "@spot/shared";

/** Who a picture is for: a comic doc ("comic") or any other WhatsApp id, such as a group or a curator ("wa"). */
export type PicKind = "comic" | "wa";
export type PicSubject = PhotoFields & { id: string; chatId?: string; phone?: string };

export interface PicDeps {
  now(): number;
  /** The saved doc (a "wa" one may not exist yet: it comes back as just its id), if there is one. */
  load(id: string, kind: PicKind): Promise<PicSubject | undefined>;
  /** The picture URL, or null when the person hides it. Throws when WhatsApp can't answer right now. */
  fetchUrl(subject: PicSubject, kind: PicKind): Promise<string | null>;
  save(id: string, patch: { photoUrl: string; photoAt: number }, kind: PicKind): Promise<void>;
  /** On the Never read list: never asked about. */
  blocked(subject: PicSubject, kind: PicKind): Promise<boolean>;
  /** WhatsApp is connected. */
  ready(): boolean;
}

export type PicStep = "idle" | "wait" | "offline" | "skipped" | "saved" | "failed";

const MAX_QUEUE = 300;

export class PicQueue {
  private queue: { id: string; force: boolean; kind: PicKind }[] = [];
  private last = Number.NEGATIVE_INFINITY;
  private gap: number;
  /** `jitter` returns 0..1; each wait is the interval plus up to half of it, so the calls are never on a fixed beat. */
  constructor(private deps: PicDeps, private intervalMs = PHOTO_INTERVAL_MS, private jitter: () => number = () => 0) {
    this.gap = intervalMs;
  }

  get size() {
    return this.queue.length;
  }

  /** Add comics or WhatsApp ids (deduped; a forced one jumps the line). Returns how many are now waiting. */
  enqueue(ids: readonly string[], force = false, kind: PicKind = "comic"): number {
    for (const id of ids.slice(0, PHOTO_BATCH_MAX)) {
      const at = this.queue.findIndex((q) => q.id === id && q.kind === kind);
      if (at >= 0) {
        if (force && !this.queue[at].force) this.queue[at].force = true;
        continue;
      }
      if (this.queue.length >= MAX_QUEUE) break;
      if (force) this.queue.unshift({ id, force, kind });
      else this.queue.push({ id, force, kind });
    }
    return this.queue.length;
  }

  /** Handle at most one comic, and only if the throttle allows. Skipped comics (fresh, blocked, missing) cost no WhatsApp call, so the next one runs at once. */
  async step(): Promise<PicStep> {
    for (;;) {
      if (!this.queue.length) return "idle";
      if (!this.deps.ready()) return "offline";
      const item = this.queue[0];
      const comic = await this.deps.load(item.id, item.kind);
      if (!comic || !photoDue(comic, this.deps.now(), item.force) || (await this.deps.blocked(comic, item.kind))) {
        this.queue.shift();
        if (this.queue.length) continue;
        return "skipped";
      }
      if (this.deps.now() - this.last < this.gap) return "wait";
      this.queue.shift();
      this.last = this.deps.now();
      this.gap = this.intervalMs + Math.round(Math.min(1, Math.max(0, this.jitter())) * this.intervalMs * 0.5);
      try {
        const url = await this.deps.fetchUrl(comic, item.kind);
        await this.deps.save(comic.id, { photoUrl: url && /^https:\/\//.test(url) ? url : PHOTO_NONE, photoAt: this.deps.now() }, item.kind);
        return "saved";
      } catch {
        return "failed"; // not saved: it is asked again next time the app shows them
      }
    }
  }
}
