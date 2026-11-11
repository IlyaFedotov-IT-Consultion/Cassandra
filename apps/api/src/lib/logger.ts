import { randomUUID } from "node:crypto";

import pino, {
  stdSerializers,
  stdTimeFunctions,
  type DestinationStream,
  type LevelWithSilent,
  type LoggerOptions,
} from "pino";

export interface AppLogger {
  child(bindings: Record<string, unknown>): AppLogger;
  debug(bindings: Record<string, unknown>, message?: string): void;
  info(bindings: Record<string, unknown>, message?: string): void;
  warn(bindings: Record<string, unknown>, message?: string): void;
  error(bindings: Record<string, unknown>, message?: string): void;
}

interface CreateLoggerArgs {
  component?: string;
  destination?: DestinationStream;
  level?: LevelWithSilent;
}

export function createLogger(args: CreateLoggerArgs = {}) {
  const options: LoggerOptions = {
    base: {
      service: "cassandra-api",
      ...(args.component ? { scope: args.component } : {}),
    },
    formatters: {
      level(label) {
        return {
          level: label,
        };
      },
    },
    level: args.level ?? "info",
    messageKey: "message",
    redact: {
      paths: [
        "authorization",
        "headers.authorization",
        "headers.cookie",
        'headers["x-api-key"]',
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-api-key"]',
      ],
      remove: true,
    },
    serializers: {
      err: stdSerializers.err,
      error: stdSerializers.err,
    },
    timestamp: stdTimeFunctions.isoTime,
  };

  return pino(options, args.destination);
}

export function resolveLogLevel(configuredLevel?: LevelWithSilent) {
  if (configuredLevel) {
    return configuredLevel;
  }

  return process.env.NODE_ENV === "test" ? "silent" : "info";
}

export function buildRequestId(headerValue: string | string[] | undefined) {
  if (Array.isArray(headerValue)) {
    return headerValue[0] ?? randomUUID();
  }

  return headerValue ?? randomUUID();
}
