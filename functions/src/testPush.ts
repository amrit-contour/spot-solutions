// "Send test push" in Nothing BOT Comedy's Settings: a notification to the caller's own Comedy devices, sent straight from a
// function (no WhatsApp server needed), so the comic can tell whether push works on their phone. Only sees ports, so it is tested with fakes.
import { AppError } from "./core";

export interface TestPushPorts {
  /** FCM tokens of the user's Comedy devices (users/{uid}/devices where app == "comic"). */
  comicTokens(uid: string): Promise<string[]>;
  /** Send the data-only message to every token; returns the tokens that landed and the ones Google says are dead. */
  send(tokens: string[], data: Record<string, string>): Promise<{ sent: number; dead: string[] }>;
  /** Forget dead tokens. */
  prune(uid: string, tokens: string[]): Promise<void>;
}

export interface TestPushCaller {
  uid?: string;
  anonymous?: boolean;
}

export const TEST_PUSH_URL = "https://nothingbotcomedy.web.app/settings";

export async function sendTestPush(ports: TestPushPorts, caller: TestPushCaller): Promise<{ sent: number; devices: number }> {
  if (!caller.uid || caller.anonymous) throw new AppError("permission-denied", "Sign in first.");
  const tokens = await ports.comicTokens(caller.uid);
  if (!tokens.length) throw new AppError("failed-precondition", "No device is set up for notifications yet. Turn them on for this device first.");
  const res = await ports.send(tokens, { kind: "test", title: "Test notification", body: "Push is working on this device.", link: TEST_PUSH_URL });
  if (res.dead.length) await ports.prune(caller.uid, res.dead);
  if (!res.sent) throw new AppError("failed-precondition", "The notification couldn't be delivered. Turn notifications off and on again for this device.");
  return { sent: res.sent, devices: tokens.length };
}
