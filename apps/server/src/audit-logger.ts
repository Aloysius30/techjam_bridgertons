/**
 * AuditLogger — Security Audit Trail
 *
 * Writes a tamper-evident append-only log for every agent action.
 * In a production system this would stream to a SIEM (e.g. Splunk, Datadog).
 * For this demo it writes to .local/audit.log on the host.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface AuditEntry {
  timestamp: string;
  event: "RUN_STARTED" | "RUN_COMPLETED" | "RUN_FAILED" | "RUN_CANCELLED" | "ACCESS_DENIED";
  agentId: string;
  ownerId?: string;
  runId?: string;
  promptPreview?: string;
  tokensUsed?: number;
  durationMs?: number;
  detail?: string;
}

export class AuditLogger {
  private readonly logPath: string;
  private initialized = false;

  constructor(dataDirectory: string) {
    this.logPath = path.join(dataDirectory, "audit.log");
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.logPath), { recursive: true });
    this.initialized = true;
  }

  async log(entry: AuditEntry): Promise<void> {
    if (!this.initialized) return;
    const line = JSON.stringify({
      ...entry,
      promptPreview: entry.promptPreview?.slice(0, 120),
    }) + "\n";
    await appendFile(this.logPath, line, "utf-8").catch(() => {});
  }
}
