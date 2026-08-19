import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../../src/cli/main.js";
import { SqliteStore } from "../../src/storage/sqlite/sqlite-store.js";

interface CliView {
  readonly mission: {
    readonly id: string;
    readonly goal: string;
  };
  readonly status: string;
  readonly currentTask: null | {
    readonly id: string;
    readonly objective: string;
    readonly status: string;
  };
  readonly recentEvent: null | {
    readonly type: string;
    readonly createdAt: string;
  };
  readonly escalation: null | {
    readonly required: boolean;
    readonly reason: string;
  };
  readonly finalResult: string | null;
}

async function invokeCli(args: readonly string[]): Promise<{
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    return {
      status: await runCli([...args]),
      stdout,
      stderr,
    };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

function parseView(stdout: string): CliView {
  return JSON.parse(stdout) as CliView;
}

function assertSixFields(view: CliView): void {
  assert.deepEqual(Object.keys(view).sort(), [
    "currentTask",
    "escalation",
    "finalResult",
    "mission",
    "recentEvent",
    "status",
  ]);
}

describe("Command & Control Runtime CLI", () => {
  it("runs a Mission and prints all six required fields", async () => {
    const directory = mkdtempSync(join(tmpdir(), "c2-cli-happy-"));
    const database = join(directory, "runtime.sqlite");
    try {
      const run = await invokeCli([
        "run",
        "mission",
        "Add completed todo endpoint",
        "--db",
        database,
        "--json",
      ]);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stderr, "");

      const view = parseView(run.stdout);
      assertSixFields(view);
      assert.equal(view.mission.goal, "Add completed todo endpoint");
      assert.equal(view.status, "completed");
      assert.equal(view.currentTask, null);
      assert.equal(view.recentEvent?.type, "MissionCompleted");
      assert.equal(view.escalation, null);
      assert.match(view.finalResult ?? "", /mission completed/i);

      const store = new SqliteStore(database);
      try {
        const durable = store.loadMissionSnapshot(view.mission.id);
        assert.equal(durable?.mission.status, "completed");
        assert.equal(durable?.tasks.length, 3);
        assert.ok(durable?.tasks.every(({ status }) => status === "completed"));
        assert.equal(durable?.events.at(-1)?.type, "MissionCompleted");
      } finally {
        store.close();
      }

      const show = await invokeCli([
        "show",
        "mission",
        view.mission.id,
        "--db",
        database,
      ]);
      assert.equal(show.status, 0, show.stderr);
      assert.match(show.stdout, /^Mission:/m);
      assert.match(show.stdout, /^Status: completed$/m);
      assert.match(show.stdout, /^Current Task: none$/m);
      assert.match(show.stdout, /^Recent Event: MissionCompleted @/m);
      assert.match(show.stdout, /^Escalation: none$/m);
      assert.match(show.stdout, /^Final Result: Mission completed/m);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("prints the same six fields with durable escalation details", async () => {
    const directory = mkdtempSync(join(tmpdir(), "c2-cli-escalation-"));
    const database = join(directory, "runtime.sqlite");
    try {
      const run = await invokeCli([
        "run",
        "mission",
        "Perform an approval-required operation",
        "--scenario",
        "escalation",
        "--db",
        database,
        "--json",
      ]);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stderr, "");

      const view = parseView(run.stdout);
      assertSixFields(view);
      assert.equal(view.status, "escalated");
      assert.equal(view.currentTask?.status, "blocked");
      assert.equal(view.recentEvent?.type, "EscalationRequested");
      assert.equal(view.escalation?.required, true);
      assert.match(view.escalation?.reason ?? "", /approval is required/i);
      assert.equal(view.finalResult, null);

      const store = new SqliteStore(database);
      try {
        const durable = store.loadMissionSnapshot(view.mission.id);
        assert.equal(durable?.mission.status, "escalated");
        assert.equal(
          durable?.events.at(-1)?.type,
          "EscalationRequested",
        );
        assert.deepEqual(
          durable?.decisions.map(({ decision }) => decision),
          ["escalate"],
        );
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
