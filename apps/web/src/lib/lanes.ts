import { INTENT_THRESHOLD, type SpotRequest } from "@spot/shared";

export type Lane = "asked" | "maybe" | "held" | "placed" | "closed";

export const laneOf = (r: SpotRequest): Lane =>
  r.status === "dismissed" || r.status === "rejected"
    ? "closed"
    : r.status === "assigned" || r.status === "confirmed"
      ? "placed"
      : r.hold && !r.holdOverridden
        ? "held"
        : r.intent.confidence >= INTENT_THRESHOLD
          ? "asked"
          : "maybe";
