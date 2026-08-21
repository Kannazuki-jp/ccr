import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const scenarios = [
  {
    name: "happy",
    goal: "CI happy path",
    arguments: [],
    expectedStatus: "completed",
    expectedEvent: "MissionCompleted",
  },
  {
    name: "escalation",
    goal: "CI escalation path",
    arguments: ["--scenario", "escalation"],
    expectedStatus: "escalated",
    expectedEvent: "EscalationRequested",
  },
];

const temporaryDirectory = mkdtempSync(join(tmpdir(), "ccr-ci-smoke-"));

try {
  for (const scenario of scenarios) {
    const databasePath = join(temporaryDirectory, `${scenario.name}.sqlite`);
    const result = spawnSync(
      process.execPath,
      [
        "dist/cli/main.js",
        "run",
        "mission",
        scenario.goal,
        ...scenario.arguments,
        "--db",
        databasePath,
        "--json",
      ],
      { encoding: "utf8" },
    );

    assert.ifError(result.error);
    assert.equal(
      result.status,
      0,
      `${scenario.name} CLI exited with ${result.status}: ${result.stderr}`,
    );

    const output = parseCliOutput(result.stdout, scenario.name);
    assert.equal(output.mission.goal, scenario.goal);
    assert.equal(output.status, scenario.expectedStatus);
    assert.equal(output.recentEvent?.type, scenario.expectedEvent);

    if (scenario.name === "happy") {
      assert.equal(output.currentTask, null);
      assert.equal(output.escalation, null);
      assert.match(output.finalResult, /completed/);
    } else {
      assert.equal(output.currentTask?.status, "blocked");
      assert.equal(output.escalation?.required, true);
      assert.equal(output.finalResult, null);
    }

    verifyPersistedState(databasePath, output);
    process.stdout.write(
      `PASS ${scenario.name}: CLI and SQLite status are ${output.status}\n`,
    );
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function parseCliOutput(stdout, scenarioName) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `${scenarioName} CLI did not emit valid JSON: ${stdout}`,
      { cause: error },
    );
  }
}

function verifyPersistedState(databasePath, output) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const missionRow = database
      .prepare("SELECT status, data FROM missions WHERE id = ?")
      .get(output.mission.id);

    assert.ok(missionRow, `Mission ${output.mission.id} was not persisted`);
    assert.equal(missionRow.status, output.status);

    const mission = JSON.parse(missionRow.data);
    assert.equal(mission.id, output.mission.id);
    assert.equal(mission.goal, output.mission.goal);
    assert.equal(mission.status, output.status);

    const eventRow = database
      .prepare(`
        SELECT type, data FROM events
        WHERE mission_id = ? AND type = ?
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .get(output.mission.id, output.recentEvent?.type);
    assert.ok(
      eventRow,
      `Recent event ${output.recentEvent?.type} was not persisted`,
    );
    assert.equal(eventRow.type, output.recentEvent?.type);
    assert.equal(JSON.parse(eventRow.data).type, output.recentEvent?.type);

    const openEscalations = database
      .prepare(`
        SELECT COUNT(*) AS count FROM escalations
        WHERE mission_id = ? AND status = 'open'
      `)
      .get(output.mission.id);
    assert.equal(openEscalations.count, output.escalation === null ? 0 : 1);

    if (output.currentTask === null) {
      const incompleteTasks = database
        .prepare(`
          SELECT COUNT(*) AS count FROM tasks
          WHERE mission_id = ? AND status != 'completed'
        `)
        .get(output.mission.id);
      assert.equal(incompleteTasks.count, 0);
      return;
    }

    const taskRow = database
      .prepare("SELECT mission_id, status, data FROM tasks WHERE id = ?")
      .get(output.currentTask.id);
    assert.ok(taskRow, `Task ${output.currentTask.id} was not persisted`);
    assert.equal(taskRow.mission_id, output.mission.id);
    assert.equal(taskRow.status, output.currentTask.status);
    assert.equal(JSON.parse(taskRow.data).status, output.currentTask.status);
  } finally {
    database.close();
  }
}
