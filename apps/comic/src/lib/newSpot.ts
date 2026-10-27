import { manualSpot, type MySpot } from "@spot/shared";

const newId = () => `spot_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A blank spot for the Add button. */
export const blankSpot = (today: string, roomName = ""): MySpot => manualSpot({ date: today, roomName }, newId(), Date.now());
