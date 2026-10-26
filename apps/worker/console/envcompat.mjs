// Servers set up before the rename to "Nothing BOT Server" keep their settings under SPOT_* names (in .env, in service
// definitions). Mirror each SPOT_X into NBS_X when NBS_X isn't set, so the rest of the code only reads NBS_*.
// Import this first (side effect) in every module that reads process.env when it loads.
export function aliasLegacyEnv(env = process.env) {
  for (const k of Object.keys(env)) {
    if (!k.startsWith("SPOT_")) continue;
    const n = `NBS_${k.slice(5)}`;
    if (env[n] === undefined) env[n] = env[k];
  }
  return env;
}
aliasLegacyEnv();
