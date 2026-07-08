import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

type TraceEvent = {
  type: string;
  [key: string]: unknown;
};

export class RunTrace {
  readonly runId = randomUUID();
  readonly filePath: string;

  constructor(root = ".runs") {
    this.filePath = join(root, `${this.runId}.jsonl`);
  }

  async write(event: TraceEvent): Promise<void> {
    await mkdir(".runs", { recursive: true });
    const record = {
      timestamp: new Date().toISOString(),
      runId: this.runId,
      ...event,
    };
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
  }
}
