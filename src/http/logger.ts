/** Minimal JSON logger for the HTTP layer; silent when disabled (e.g. in tests). */
export interface Logger {
  error(msg: string, err?: unknown): void;
}

export function createLogger(enabled: boolean): Logger {
  return {
    error(msg, err) {
      if (!enabled) return;
      console.error(JSON.stringify({ level: 'error', time: Date.now(), msg, ...(err ? { detail: String(err) } : {}) }));
    },
  };
}
