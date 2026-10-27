// Who is this chat? One precedence for every place the worker names a person, so Never read, the thread list, group writers,
// the agent and the roster import all agree. Pure: the worker feeds it what WhatsApp and Comics know.

/** What WhatsApp can tell us about one contact (whatsapp-web.js Contact fields). */
export interface ContactNames {
  name?: string | null;
  shortName?: string | null;
  pushname?: string | null;
  verifiedName?: string | null;
  isMyContact?: boolean;
}

/** "+91 98765 43210", "919876543210" and "9876-543-210" are numbers, not names. */
export const looksLikeNumber = (s: string | null | undefined) => {
  const t = (s ?? "").trim();
  return !t || /^[+\d\s\-().  ]+$/.test(t);
};

const real = (s: string | null | undefined) => {
  const t = (s ?? "").trim();
  return t && !looksLikeNumber(t) ? t : "";
};

/**
 * A contact's best name: the name saved in your phone book, then the name on the contact, WhatsApp's short name, the profile
 * (push) name, the business's verified name. Never a bare number: that is the caller's last resort.
 */
export function bestContactName(c: ContactNames | null | undefined): string {
  if (!c) return "";
  return (c.isMyContact ? real(c.name) : "") || real(c.name) || real(c.shortName) || real(c.pushname) || real(c.verifiedName);
}

/** The label of last resort: "+919876543210" (or "" when there is no phone). */
export const numberLabel = (phone: string | null | undefined) => {
  const d = (phone ?? "").replace(/\D/g, "");
  return d ? `+${d}` : "";
};

/**
 * The name to show for a person: your Comics name, else a name already worked out, else what WhatsApp's chat list called them
 * (only if it is a real name, not their number), else their number.
 */
export function chatDisplayName(parts: { comic?: string; contact?: ContactNames | null; resolved?: string; chatName?: string; phone?: string }): string {
  return parts.comic?.trim() || real(parts.resolved) || bestContactName(parts.contact) || real(parts.chatName) || numberLabel(parts.phone) || (parts.chatName ?? "").trim();
}
