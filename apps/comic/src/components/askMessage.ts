// The text of an ask, from a draft the comic saved or from their template.
import { renderAsk, type PlannedAsk } from "@spot/shared";

export const messageFor = (a: PlannedAsk, template: string) =>
  a.doc?.message?.trim() || renderAsk(template, { curatorName: a.curatorName, roomName: a.roomName, show: a.label, showDate: a.showDate, time: a.time });
