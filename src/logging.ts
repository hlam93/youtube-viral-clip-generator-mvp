import { hashValue } from './utils.js';

export type LogLevel = 'info' | 'warn' | 'error';

export interface StructuredLogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

export interface StructuredLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export type StructuredLogSink = (entry: StructuredLogEntry) => void;

const sanitizeValue = (value: unknown): unknown => {
  if (value === undefined || typeof value === 'function') {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item)).filter((item) => item !== undefined);
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .map(([key, nestedValue]) => [key, sanitizeValue(nestedValue)] as const)
      .filter((entry) => entry[1] !== undefined);
    return Object.fromEntries(entries);
  }

  return value;
};

const defaultSink: StructuredLogSink = (entry) => {
  const serialized = JSON.stringify(entry);
  if (entry.level === 'error') {
    console.error(serialized);
    return;
  }

  if (entry.level === 'warn') {
    console.warn(serialized);
    return;
  }

  console.log(serialized);
};

const writeLog =
  (level: LogLevel, sink: StructuredLogSink) =>
  (event: string, fields: Record<string, unknown> = {}) => {
    const entry = sanitizeValue({
      ts: new Date().toISOString(),
      level,
      event,
      ...fields
    }) as StructuredLogEntry;
    sink(entry);
  };

export const createStructuredLogger = (sink: StructuredLogSink = defaultSink): StructuredLogger => ({
  info: writeLog('info', sink),
  warn: writeLog('warn', sink),
  error: writeLog('error', sink)
});

export const hashForLog = (value: string) => `sha1:${hashValue(value)}`;
