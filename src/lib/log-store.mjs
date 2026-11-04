import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

const SENSITIVE_KEY =
  /(?:authorization|cookie|credential|password|passcode|secret|token|request[_-]?headers?)/iu;

function safeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[redacted-url]";
  }
}

function sanitizedValue(key, value) {
  if (SENSITIVE_KEY.test(key)) return undefined;
  if (typeof value === "string" && /(?:^|[_-])url$/iu.test(key)) {
    return safeUrl(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizedValue("", item))
      .filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .map(([nestedKey, nestedValue]) => [
          nestedKey,
          sanitizedValue(nestedKey, nestedValue),
        ])
        .filter(([, nestedValue]) => nestedValue !== undefined),
    );
  }
  return value;
}

export class LogStore extends EventEmitter {
  constructor({ limit = 500, filePath = null } = {}) {
    super();
    this.limit = limit;
    this.filePath = filePath;
    this.events = [];
  }

  add(level, event, message, context = {}) {
    const entry = sanitizedValue("", {
      timestamp: new Date().toISOString(),
      level,
      event,
      message,
      ...context,
    });
    this.events.push(entry);
    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit);
    }
    if (this.filePath) {
      try {
        const directory = path.dirname(this.filePath);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.chmodSync(directory, 0o700);
        fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        fs.chmodSync(this.filePath, 0o600);
      } catch (error) {
        this.emit("persistence-error", error);
      }
    }
    this.emit("entry", entry);
    return entry;
  }

  recent() {
    return [...this.events];
  }
}
