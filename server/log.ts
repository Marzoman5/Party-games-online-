/**
 * Tiny logger. `quiet` silences info/debug chatter (joins, leaves...) but never
 * errors or warnings - those matter when something goes wrong at the party.
 */
export interface Logger {
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

export function createLogger(quiet: boolean): Logger {
  const ts = (): string => new Date().toTimeString().slice(0, 8);
  return {
    info: (...a) => {
      if (!quiet) console.log(`[${ts()}]`, ...a);
    },
    warn: (...a) => console.warn(`[${ts()}] WARN`, ...a),
    error: (...a) => console.error(`[${ts()}] ERROR`, ...a),
  };
}
