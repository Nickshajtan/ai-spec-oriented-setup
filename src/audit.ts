import type { AuditRecord, AuditSink } from "./types.ts";

export class InMemoryAuditSink implements AuditSink {
  private readonly entries: AuditRecord[] = [];

  record(entry: AuditRecord): void {
    this.entries.push(entry);
  }

  getRecords(): AuditRecord[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries.length = 0;
  }
}
