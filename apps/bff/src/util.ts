export class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  private readonly max: number;
  constructor(max: number) { this.max = Math.max(1, max); }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`);
}

export function matchesAny(page: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(page));
}

export const log = {
  info: (...a: unknown[]) => console.log(new Date().toISOString(), '[info]', ...a),
  warn: (...a: unknown[]) => console.warn(new Date().toISOString(), '[warn]', ...a),
  error: (...a: unknown[]) => console.error(new Date().toISOString(), '[error]', ...a),
};
