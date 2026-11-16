/**
 * Minimal leveled logger writing to stdout/stderr.
 * Level is controlled by LOG_LEVEL (debug | info | warn | error).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveLevel(env?: string): LogLevel {
  const v = (env ?? 'info').toLowerCase();
  return v in LEVEL_ORDER ? (v as LogLevel) : 'info';
}

export class Logger {
  private readonly threshold: number;

  constructor(level?: LogLevel) {
    this.threshold = LEVEL_ORDER[level ?? resolveLevel(process.env.LOG_LEVEL)];
  }

  private emit(level: LogLevel, msg: string): void {
    if (LEVEL_ORDER[level] < this.threshold) return;
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
    if (level === 'error') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }

  debug(msg: string): void {
    this.emit('debug', msg);
  }

  info(msg: string): void {
    this.emit('info', msg);
  }

  warn(msg: string): void {
    this.emit('warn', msg);
  }

  error(msg: string): void {
    this.emit('error', msg);
  }
}

export const logger = new Logger();
