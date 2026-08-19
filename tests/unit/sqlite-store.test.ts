import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import type {
  AgentRecord,
  Decision,
  Event,
  Mission,
  Report,
  Task,
} from "../../src/domain/index.js";
import { InvalidStateTransitionError } from "../../src/runtime/state-machine.js";
import {
  DirectStateMutationError,
  SqliteStore,
  TransitionEventMismatchError,
} from "../../src/storage/sqlite/index.js";

const MISSION_ID = "00000000-0000-4000-8000-000000000001";
const TASK_ID = "00000000-0000-4000-8000-000000000002";
const REPORT_ID = "00000000-0000-4000-8000-000000000003";
const DECISION_ID = "00000000-0000-4000-8000-000000000004";
const CREATED_EVENT_ID = "00000000-0000-4000-8000-000000000005";
const TRANSITION_EVENT_ID = "00000000-0000-4000-8000-000000000006";

function mission(status: Mission["status"] = "created"): Mission {
  const createdAt = new Date("2026-08-19T00:00:00.000Z");
  return {
    id: MISSION_ID,
    goal: "Add completed todo endpoint",
    intent: {
      purpose: "Expose completed todos",
      endState: ["The endpoint returns completed todos"],
      priorities: ["correctness"],
      constraints: ["Keep the existing API compatible"],
    },
    successCriteria: ["The integration test passes"],
    status,
    createdAt,
    updatedAt: createdAt,
  };
}

function task(status: Task["status"] = "pending"): Task {
  const createdAt = new Date("2026-08-19T00:01:00.000Z");
  return {
    id: TASK_ID,
    missionId: MISSION_ID,
    objective: "Implement endpoint",
    successCriteria: ["Endpoint test passes"],
    constraints: [],
    authority: {
      allowed: ["edit source files"],
      prohibited: ["change public API"],
      requiresApproval: [],
    },
    dependencies: [],
    status,
    attempts: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

function agent(): AgentRecord {
  const createdAt = new Date("2026-08-19T00:02:00.000Z");
  return {
    id: "mock-worker",
    name: "Mock Worker",
    role: "worker",
    implementation: "mock",
    createdAt,
    updatedAt: createdAt,
  };
}

function report(): Report {
  return {
    id: REPORT_ID,
    missionId: MISSION_ID,
    taskId: TASK_ID,
    agentId: "mock-worker",
    attempt: 1,
    output: { changedFiles: ["src/todos.ts"] },
    status: "success",
    summary: "Implemented the endpoint",
    problems: [],
    risks: [],
    decisionRequired: false,
    createdAt: new Date("2026-08-19T00:03:00.000Z"),
  };
}

function decision(): Decision {
  return {
    id: DECISION_ID,
    missionId: MISSION_ID,
    taskId: TASK_ID,
    actor: "lead",
    decision: "Run the evaluator",
    rationale: ["Worker returned a successful report"],
    createdAt: new Date("2026-08-19T00:04:00.000Z"),
  };
}

function event(
  id: string,
  type: string,
  createdAt = new Date("2026-08-19T00:05:00.000Z"),
): Event {
  return {
    id,
    missionId: MISSION_ID,
    type,
    actor: "runtime",
    payload: {},
    createdAt,
  };
}

describe("SqliteStore", () => {
  it("persists every required table and hydrates JSON dates", () => {
    const store = new SqliteStore();
    try {
      store.saveMission(mission());
      store.saveAgent(agent());
      store.saveTask(task());
      store.saveReport(report());
      store.saveDecision(decision());
      store.appendEvent(event(CREATED_EVENT_ID, "MissionCreated"));

      const snapshot = store.loadSnapshot();
      assert.equal(snapshot.missions.length, 1);
      assert.equal(snapshot.tasks.length, 1);
      assert.equal(snapshot.agents.length, 1);
      assert.equal(snapshot.reports.length, 1);
      assert.equal(snapshot.decisions.length, 1);
      assert.equal(snapshot.events.length, 1);
      assert.ok(snapshot.missions[0]?.createdAt instanceof Date);
      assert.ok(snapshot.tasks[0]?.updatedAt instanceof Date);
      assert.ok(snapshot.agents[0]?.createdAt instanceof Date);
      assert.ok(snapshot.reports[0]?.createdAt instanceof Date);
      assert.ok(snapshot.decisions[0]?.createdAt instanceof Date);
      assert.ok(snapshot.events[0]?.createdAt instanceof Date);

      const missionSnapshot = store.loadMissionSnapshot(MISSION_ID);
      assert.equal(missionSnapshot?.mission.id, MISSION_ID);
      assert.deepEqual(missionSnapshot?.tasks.map(({ id }) => id), [TASK_ID]);
      assert.deepEqual(missionSnapshot?.reports.map(({ id }) => id), [REPORT_ID]);
      assert.deepEqual(missionSnapshot?.decisions.map(({ id }) => id), [DECISION_ID]);
      assert.deepEqual(missionSnapshot?.events.map(({ id }) => id), [CREATED_EVENT_ID]);
      assert.equal(store.loadMissionSnapshot("00000000-0000-4000-8000-999999999999"), undefined);
    } finally {
      store.close();
    }
  });

  it("commits valid state and event transitions atomically", () => {
    const store = new SqliteStore();
    try {
      store.saveMission(mission());
      store.saveTask(task());

      const planningEvent = event(TRANSITION_EVENT_ID, "MissionPlanning");
      const transitionedMission = store.transitionMission(MISSION_ID, "planning", planningEvent);
      assert.equal(transitionedMission.status, "planning");
      assert.equal(store.getMission(MISSION_ID)?.status, "planning");
      assert.deepEqual(store.listEvents(MISSION_ID).map(({ id }) => id), [TRANSITION_EVENT_ID]);

      const taskEvent = event(
        "00000000-0000-4000-8000-000000000007",
        "TaskStarted",
        new Date("2026-08-19T00:06:00.000Z"),
      );
      const transitionedTask = store.transitionTask(TASK_ID, "running", taskEvent);
      assert.equal(transitionedTask.status, "running");
      assert.equal(store.getTask(TASK_ID)?.status, "running");
      assert.equal(store.listEvents(MISSION_ID).length, 2);
    } finally {
      store.close();
    }
  });

  it("rolls back the state update when appending its event fails", () => {
    const store = new SqliteStore();
    try {
      store.saveMission(mission());
      store.appendEvent(event(CREATED_EVENT_ID, "MissionCreated"));

      assert.throws(
        () => store.transitionMission(
          MISSION_ID,
          "planning",
          event(CREATED_EVENT_ID, "MissionPlanning"),
        ),
        /UNIQUE constraint failed: events.id/,
      );
      assert.equal(store.getMission(MISSION_ID)?.status, "created");
      assert.equal(store.listEvents(MISSION_ID).length, 1);
    } finally {
      store.close();
    }
  });

  it("rejects illegal transitions and mismatched transition events without mutation", () => {
    const store = new SqliteStore();
    try {
      store.saveMission(mission("completed"));
      store.saveTask(task("completed"));

      assert.throws(
        () => store.transitionMission(
          MISSION_ID,
          "executing",
          event(TRANSITION_EVENT_ID, "MissionExecuting"),
        ),
        InvalidStateTransitionError,
      );
      assert.throws(
        () => store.transitionTask(
          TASK_ID,
          "running",
          event(TRANSITION_EVENT_ID, "TaskStarted"),
        ),
        InvalidStateTransitionError,
      );

      assert.throws(
        () => store.saveMission(mission("created")),
        DirectStateMutationError,
      );
      assert.throws(
        () => store.saveTask(task("pending")),
        DirectStateMutationError,
      );

      const createdMission = {
        ...mission("created"),
        id: "00000000-0000-4000-8000-000000000098",
      };
      store.saveMission(createdMission);
      const mismatched = event(TRANSITION_EVENT_ID, "MissionPlanning");
      assert.throws(
        () => store.transitionMission(createdMission.id, "planning", mismatched),
        TransitionEventMismatchError,
      );
      assert.equal(store.getMission(createdMission.id)?.status, "created");
      assert.equal(store.listEvents().length, 0);
    } finally {
      store.close();
    }
  });

  it("rolls back paired entity and event writes when the event is rejected", () => {
    const store = new SqliteStore();
    try {
      store.saveMission(mission());
      store.saveTask(task());
      store.appendEvent(event(CREATED_EVENT_ID, "MissionCreated"));

      const assignedTask: Task = {
        ...task(),
        assignedAgentId: "mock-worker",
        attempts: 1,
        updatedAt: new Date("2026-08-19T00:04:30.000Z"),
      };
      assert.throws(
        () =>
          store.saveTaskAndEvent(
            assignedTask,
            event(CREATED_EVENT_ID, "TaskAssigned"),
          ),
        /UNIQUE constraint failed: events.id/,
      );
      assert.equal(store.getTask(TASK_ID)?.attempts, 0);
      assert.equal(store.getTask(TASK_ID)?.assignedAgentId, undefined);

      assert.throws(
        () =>
          store.saveReportAndEvent(
            report(),
            event(CREATED_EVENT_ID, "ReportSubmitted"),
          ),
        /UNIQUE constraint failed: events.id/,
      );
      assert.deepEqual(store.listReports(MISSION_ID), []);
      assert.equal(store.listEvents(MISSION_ID).length, 1);
    } finally {
      store.close();
    }
  });

  it("restores a complete mission snapshot after process-style reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "cc-runtime-store-"));
    const databasePath = join(directory, "runtime.sqlite");

    try {
      const writer = new SqliteStore(databasePath);
      writer.saveMission(mission());
      writer.saveAgent(agent());
      writer.saveTask(task());
      writer.saveReport(report());
      writer.saveDecision(decision());
      writer.appendEvent(event(CREATED_EVENT_ID, "MissionCreated"));
      writer.close();

      const reader = new SqliteStore(databasePath);
      try {
        const restored = reader.loadMissionSnapshot(MISSION_ID);
        assert.equal(restored?.mission.goal, "Add completed todo endpoint");
        assert.equal(restored?.tasks[0]?.objective, "Implement endpoint");
        assert.equal(restored?.reports[0]?.summary, "Implemented the endpoint");
        assert.equal(restored?.decisions[0]?.decision, "Run the evaluator");
        assert.equal(restored?.events[0]?.type, "MissionCreated");
        assert.ok(restored?.mission.updatedAt instanceof Date);
      } finally {
        reader.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps events append-only by rejecting duplicate identifiers", () => {
    const store = new SqliteStore();
    try {
      store.saveMission(mission());
      store.appendEvent(event(CREATED_EVENT_ID, "MissionCreated"));
      assert.throws(
        () => store.appendEvent(event(CREATED_EVENT_ID, "MissionChanged")),
        /UNIQUE constraint failed: events.id/,
      );
      assert.deepEqual(store.listEvents().map(({ type }) => type), ["MissionCreated"]);
    } finally {
      store.close();
    }
  });

  it("enforces append-only events against direct SQL updates and deletes", () => {
    const directory = mkdtempSync(join(tmpdir(), "cc-runtime-append-only-"));
    const databasePath = join(directory, "runtime.sqlite");

    try {
      const store = new SqliteStore(databasePath);
      store.saveMission(mission());
      store.appendEvent(event(CREATED_EVENT_ID, "MissionCreated"));
      store.close();

      const database = new DatabaseSync(databasePath);
      try {
        assert.throws(
          () => database.prepare("UPDATE events SET type = ? WHERE id = ?").run(
            "MissionChanged",
            CREATED_EVENT_ID,
          ),
          /events are append-only/,
        );
        assert.throws(
          () => database.prepare("DELETE FROM events WHERE id = ?").run(CREATED_EVENT_ID),
          /events are append-only/,
        );
      } finally {
        database.close();
      }

      const reader = new SqliteStore(databasePath);
      try {
        assert.deepEqual(reader.listEvents().map(({ type }) => type), ["MissionCreated"]);
      } finally {
        reader.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
