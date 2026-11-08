import { scrubSecrets } from './secrets.ts';

/**
 * Minimal structured logger interface. Production uses pino behind this interface;
 * the built-in JSON logger keeps packages dependency-free and testable.
 */
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

/** Keys whose values never reach a log line or the audit log. */
const REDACT_KEYS =
  /^(authorization|proxy[-_]?authorization|cookies?|set-cookie|password|passwd|passphrase|secret|client[-_]?secret|app[-_]?secret|signing[-_]?secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|bot[-_]?token|session[-_]?token|api[-_]?key|apikey|x-api-key|private[-_]?key|master[-_]?key|pkcs8|credentials?|code[-_]?verifier|webhook[-_]?url)$/i;

/** Redacts secret-named keys at any depth and masks credentials found inside string values. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubSecrets(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[truncated]'; // never pass deeper structures through unchecked
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

export function createJsonLogger(options: {
  level?: LogLevel;
  bindings?: Record<string, unknown>;
  write?: (line: string) => void;
} = {}): Logger {
  const min = LEVELS[options.level ?? 'info'];
  const bindings = options.bindings ?? {};
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  const safeBindings = redact(bindings) as Record<string, unknown>;
  const log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < min) return;
    const entry = { ts: new Date().toISOString(), level, msg: scrubSecrets(msg), ...safeBindings, ...(fields ? (redact(fields) as object) : {}) };
    write(JSON.stringify(entry));
  };

  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
    child: (fields) => createJsonLogger({ ...options, bindings: { ...bindings, ...fields } }),
  };
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};
