// The queue behind profile pictures: one WhatsApp lookup per interval, nothing for Never read people, "none" remembered for
// hidden photos. No WhatsApp or Firestore in here (they come in as `deps`), so the rules are tested with fakes.
import { PHOTO_BATCH_MAX, PHOTO_INTERVAL_MS, PHOTO_NONE, photoDue, type Comic } from "@spot/shared";

export interface PicDeps {
  now(): number;
  /** The comic's saved doc, if there is one. */
  load(comicId: string): Promise<Comic | undefined>;
  /** The picture URL, or null when the person hides it. Throws when WhatsApp can't answer right now. */
  fetchUrl(comic: Comic): Promise<string | null>;
  save(comicId: string, patch: { photoUrl: string; photoAt: number }): Promise<void>;
  /** On the Never read list: never asked about. */
  blocked(comic: Comic): Promise<boolean>;
  /** WhatsApp is connected. */
  ready(): boolean;
}

export type PicStep = "idle" | "wait" | "offline" | "skipped" | "saved" | "failed";

const MAX_QUEUE = 300;

export class PicQueue {
  private queue: { id: string; force: boolean }[] = [];
  private last = Number.NEGATIVE_INFINITY;
  constructor(private deps: PicDeps, private intervalMs = PHOTO_INTERVAL_MS) {}

  get size() {
    return this.queue.length;
  }

  /** Add comics (deduped; a forced one jumps the line). Returns how many are now waiting. */
  enqueue(ids: readonly string[], force = false): number {
    for (const id of ids.slice(0, PHOTO_BATCH_MAX)) {
      const at = this.queue.findIndex((q) => q.id === id);
      if (at >= 0) {
        if (force && !this.queue[at].force) this.queue[at].force = true;
        continue;
      }
      if (this.queue.length >= MAX_QUEUE) break;
      if (force) this.queue.unshift({ id, force });
      else this.queue.push({ id, force });
    }
    return this.queue.length;
  }

  /** Handle at most one comic, and only if the throttle allows. Skipped comics (fresh, blocked, missing) cost no WhatsApp call, so the next one runs at once. */
  async step(): Promise<PicStep> {
    for (;;) {
      if (!this.queue.length) return "idle";
      if (!this.deps.ready()) return "offline";
      const item = this.queue[0];
      const comic = await this.deps.load(item.id);
      if (!comic || !photoDue(comic, this.deps.now(), item.force) || (await this.deps.blocked(comic))) {
        this.queue.shift();
        if (this.queue.length) continue;
        return "skipped";
      }
      if (this.deps.now() - this.last < this.intervalMs) return "wait";
      this.queue.shift();
      this.last = this.deps.now();
      try {
        const url = await this.deps.fetchUrl(comic);
        await this.deps.save(comic.id, { photoUrl: url && /^https:\/\//.test(url) ? url : PHOTO_NONE, photoAt: this.deps.now() });
        return "saved";
      } catch {
        return "failed"; // not saved: it is asked again next time the app shows them
      }
    }
  }
}
