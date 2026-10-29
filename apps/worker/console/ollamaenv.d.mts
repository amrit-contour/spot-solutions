// Types for the bits of ollamaenv.mjs the worker (TypeScript) imports.
export function winRestartOllamaScript(o: { exe?: string; dir?: string; env?: Record<string, string | undefined>; root?: string }): string;
export function winStartOllamaScript(o: { exe?: string; dir?: string; env?: Record<string, string | undefined>; root?: string; found?: boolean }): string;
export function winFindOllamaScript(o: { exe?: string; root?: string }): string;
