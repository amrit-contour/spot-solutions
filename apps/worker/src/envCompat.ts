// Servers installed before the rename to "Nothing BOT Server" keep their settings under SPOT_* names (in .env, in
// service definitions). Mirror each SPOT_X into NBS_X when NBS_X isn't set, so the rest of the code only reads NBS_*.
// Import this first (side effect) in every entry point, before any module that reads process.env.
export function aliasLegacyEnv(env: Record<string, string | undefined> = process.env): void {
  for (const k of Object.keys(env)) {
    if (!k.startsWith("SPOT_")) continue;
    const n = `NBS_${k.slice(5)}`;
    if (env[n] === undefined) env[n] = env[k];
  }
}
aliasLegacyEnv();
