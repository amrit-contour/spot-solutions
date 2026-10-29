// Can other devices on this Wi-Fi open the console? On Windows two things decide it: the network's profile (a Public network
// blocks inbound connections) and our firewall rule for TCP 7420 (install.ps1 adds it for Private and Domain).
// The Status page warns when the active network is Public and offers "Make private" (Set-NetConnectionProfile), which also puts the
// firewall rule back if it is missing or covers too little. Same pattern as power.mjs: PowerShell prints JSON, errors are reported as text.

export const RULE = "Nothing BOT Server Console";
const psq = (t) => String(t).replace(/'/g, "''");
/** Active connection profiles and our firewall rule, as one JSON object. */
export const PS_NET_PROFILE_READ = `$p = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; alias = [string]$_.InterfaceAlias; index = [int]$_.InterfaceIndex; category = [string]$_.NetworkCategory } }); $r = @(Get-NetFirewallRule -DisplayName '${psq(RULE)}' -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ enabled = [string]$_.Enabled; profile = [string]$_.Profile; action = [string]$_.Action } }); [pscustomobject]@{ profiles = $p; rules = $r } | ConvertTo-Json -Compress -Depth 4`;
/** Makes the given interfaces Private (indexes come from our own read, never from the page) and makes sure the firewall rule covers Private and Domain. */
export function psMakePrivate(indexes) {
  const ids = indexes.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const set = ids.map((i) => `try { Set-NetConnectionProfile -InterfaceIndex ${i} -NetworkCategory Private -ErrorAction Stop; $done += 'interface ${i}' } catch { $errs += ('interface ${i}: ' + [string]$_.Exception.Message) }`).join("; ");
  return `$done = @(); $errs = @(); ${set}; try { $r = @(Get-NetFirewallRule -DisplayName '${psq(RULE)}' -ErrorAction SilentlyContinue); $bad = ($r.Count -eq 0) -or -not ($r | Where-Object { $_.Enabled -eq 'True' -and $_.Action -eq 'Allow' -and ([string]$_.Profile -match 'Private|Any') -and ([string]$_.Profile -match 'Domain|Any') }); if ($bad) { Remove-NetFirewallRule -DisplayName '${psq(RULE)}' -ErrorAction SilentlyContinue; New-NetFirewallRule -DisplayName '${psq(RULE)}' -Direction Inbound -Protocol TCP -LocalPort 7420 -Action Allow -Profile Private,Domain -ErrorAction Stop | Out-Null; $done += 'firewall rule' } } catch { $errs += ('firewall rule: ' + [string]$_.Exception.Message) }; [pscustomobject]@{ done = $done; errors = $errs } | ConvertTo-Json -Compress`;
}

const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
/** The PowerShell answer for the page: { profiles, public: [...], firewall: { found, ok, profiles } }. null when it isn't JSON. */
export function parseNetProfile(text) {
  let j;
  try { j = JSON.parse(String(text ?? "").trim()); } catch { return null; }
  const profiles = list(j?.profiles).map((p) => ({ name: String(p.name ?? ""), alias: String(p.alias ?? ""), index: Number(p.index) || 0, category: String(p.category ?? "") }));
  const rules = list(j?.rules).map((r) => ({ enabled: String(r.enabled ?? ""), profile: String(r.profile ?? ""), action: String(r.action ?? "") }));
  const covers = (word) => rules.some((r) => r.enabled === "True" && r.action === "Allow" && (r.profile.includes(word) || r.profile === "Any"));
  return {
    profiles,
    // DomainAuthenticated counts as Domain; only Public blocks the console.
    public: profiles.filter((p) => p.category === "Public"),
    firewall: { found: rules.length > 0, ok: covers("Private") && covers("Domain"), profiles: [...new Set(rules.map((r) => r.profile))].join(", ") },
  };
}

export function createNetProfile({ platform, ps, dry = false, now = Date.now }) {
  let cache = { at: 0, v: null };
  async function view(fresh = false) {
    if (platform !== "win32") return null;
    if (!fresh && now() - cache.at < 60_000) return cache.v;
    const r = await ps(PS_NET_PROFILE_READ, 20000);
    cache = { at: now(), v: r.ok ? parseNetProfile(r.out) : null };
    return cache.v;
  }
  async function makePrivate() {
    if (platform !== "win32") throw Object.assign(new Error("Only Windows has network profiles."), { status: 400 });
    const v = await view(true);
    if (!v) throw new Error("Couldn't read this computer's network profile (Get-NetConnectionProfile).");
    if (!v.public.length && v.firewall.ok) return { ok: true, note: "This network is already Private.", view: v };
    if (dry) return { ok: true, dry: true, note: "Test console: nothing was changed.", view: v };
    const r = await ps(psMakePrivate(v.public.map((p) => p.index)), 30000);
    let out = null;
    try { out = JSON.parse(r.out); } catch { /* the error text is in r.out */ }
    const errors = list(out?.errors).map(String);
    const after = await view(true);
    if (!out || errors.length || after?.public.length) {
      const why = errors.join("; ") || (r.out || "PowerShell gave no answer").slice(0, 300);
      throw new Error(`Couldn't make this network Private: ${why}. In Windows Settings, open Network & internet, Wi-Fi, this network, and choose Private network.`);
    }
    return { ok: true, note: `Done: ${list(out.done).join(", ") || "nothing needed"}. Other devices on this Wi-Fi can open the console now.`, view: after };
  }
  return { view, makePrivate };
}
