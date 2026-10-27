// Admin emails: the worker reads NBS_ADMIN_EMAILS once at start, so a real change needs a restart and an unchanged list doesn't.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function planAdmins(current, input) {
  const list = (Array.isArray(input) ? input : []).map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  const emails = [...new Set(list.filter((e) => EMAIL.test(e)))];
  const rejected = [...new Set(list.filter((e) => !EMAIL.test(e)))];
  const before = String(current ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const changed = before.join(",") !== emails.join(",");
  return { emails, rejected, changed };
}
