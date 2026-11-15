/** A small logger interface, and a scrubber that removes secrets from anything printed. */

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/**
 * Replaces each secret (and any `api-key=...` text) in `text` with `[redacted]`.
 * Secrets shorter than 6 characters are ignored so a short value cannot garble
 * ordinary text.
 */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 6) out = out.split(s).join('[redacted]');
  }
  return out.replace(/api-key=[^&\s"'<>]+/gi, 'api-key=[redacted]');
}

export interface ConsoleLoggerOptions {
  secrets?: readonly string[];
  write?: (line: string) => void;
}

export function consoleLogger(opts: ConsoleLoggerOptions = {}): Logger {
  const secrets = opts.secrets ?? [];
  const write = opts.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const emit = (level: string, message: string, fields?: Record<string, unknown>) => {
    const tail = fields ? ` ${JSON.stringify(fields)}` : '';
    write(scrub(`${level} ${message}${tail}`, secrets));
  };
  return {
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

/** Every environment value that must never be printed. */
export function secretsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const secrets: string[] = [];
  for (const name of [
    'HELIUS_API_KEY',
    'JUPITER_API_KEY',
    'CODEX_API_KEY',
    'DUNE_API_KEY',
    'DEXPAPRIKA_API_KEY',
    'BIRDEYE_API_KEY',
    'ANTHROPIC_API_KEY',
  ]) {
    const v = env[name];
    if (v) secrets.push(v);
  }
  // A database URL carries a password: scrub the password, not the whole URL.
  for (const name of ['DATABASE_URL', 'TEST_DATABASE_ADMIN_URL']) {
    const v = env[name];
    if (!v) continue;
    try {
      const pw = new URL(v).password;
      if (pw) secrets.push(decodeURIComponent(pw));
    } catch {
      // not a URL; nothing to scrub
    }
  }
  return secrets;
}
