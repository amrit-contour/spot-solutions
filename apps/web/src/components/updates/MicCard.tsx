// Morning-after check for a confirmed show that is now in the past.
import { formatDate, type Lineup, type Show } from "@spot/shared";
import { updateDoc } from "firebase/firestore";
import { useApp } from "../../lib/app";
import { userDoc } from "../../lib/data";
import { markCanned } from "../../lib/lineup";
import { answerMicCheck } from "../../lib/updates";
import { Button } from "@spot/ui";
import { IconCheck, IconMic } from "@spot/ui";
import { UpdateItem } from "./shared";

export function MicCard({ lineup: l, show }: { lineup: Lineup; show: Show }) {
  const { uid, comicsById } = useApp();
  return (
    <UpdateItem className="bg-secondary-container text-on-secondary-container">
      <div className="flex gap-3 px-4 pt-4">
        <IconMic className="icon mt-0.5 size-6 flex-none" />
        <p className="min-w-0 flex-1 type-body-l">
          Did <span className="type-title-s">{show.name}</span> on {formatDate(l.date)} happen?
        </p>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2 px-3 pb-3">
        <Button variant="text" className="text-on-secondary-container" onClick={() => void markCanned(uid, l, show, comicsById).then(() => updateDoc(userDoc(uid, "lineups", l.id), { outcome: "canned" }))}>
          No
        </Button>
        <Button icon={IconCheck} onClick={() => answerMicCheck(uid, l, "happened")} data-primary>
          Yes, it happened
        </Button>
      </div>
    </UpdateItem>
  );
}
