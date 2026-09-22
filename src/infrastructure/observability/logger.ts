import { redactSensitiveLogFields } from "../../http/security/log-redaction";

export type LogLevel = "info" | "warn" | "error";

export type OperationalLogFields = {
  requestId?: string | undefined;
  method?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  errorCode?: string;
  operation?: string;
  attempt?: number;
  delayMs?: number;
  activeRequests?: number;
  gracePeriodMs?: number;
  signal?: string;
  state?: string;
};

export interface OperationalLogger {
  log(level: LogLevel, event: string, fields?: OperationalLogFields): void;
}

type LogWriter = (line: string, level: LogLevel) => void;

const allowedFields = new Set<keyof OperationalLogFields>([
  "requestId",
  "method",
  "route",
  "status",
  "durationMs",
  "errorCode",
  "operation",
  "attempt",
  "delayMs",
  "activeRequests",
  "gracePeriodMs",
  "signal",
  "state",
]);

export class JsonLogger implements OperationalLogger {
  constructor(
    private readonly writer: LogWriter = (line, level) => {
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    },
    private readonly wallClock: () => Date = () => new Date(),
  ) {}

  log(
    level: LogLevel,
    event: string,
    fields: OperationalLogFields = {},
  ): void {
    const safeFields: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(fields)) {
      if (allowedFields.has(name as keyof OperationalLogFields) && value !== undefined) {
        safeFields[name] = value;
      }
    }
    const entry = redactSensitiveLogFields({
      timestamp: this.wallClock().toISOString(),
      level,
      event,
      ...safeFields,
    });
    this.writer(JSON.stringify(entry), level);
  }
}

export const noOpLogger: OperationalLogger = { log: () => {} };
