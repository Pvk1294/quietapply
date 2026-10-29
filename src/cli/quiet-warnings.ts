/**
 * Node 22 prints "SQLite is an experimental feature" whenever node:sqlite loads. QuietApply depends on it on
 * purpose (nothing native to compile), so that one warning is hidden. Every other warning still shows.
 * Imported first by the CLI, before anything loads node:sqlite.
 */
const emit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (/SQLite is an experimental feature/i.test(text)) return;
  (emit as (w: string | Error, ...r: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
