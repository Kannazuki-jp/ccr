import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import type {
  AgentRecord,
  AuthorityGrant,
  AuthorizationRecord,
  Constraint,
  Decision,
  DoctrineViolationRecord,
  EscalationRecord,
  Event,
  Mission,
  Report,
  RiskLimit,
  Task,
} from "../../src/domain/index.js";
import { InvalidStateTransitionError } from "../../src/runtime/state-machine.js";
import { DoctrineEnforcer } from "../../src/runtime/doctrine/enforcer.js";
import { issueRuntimeTransitionPermit } from "../../src/runtime/transition-permit.js";
import {
  DirectStateMutationError,
  AuthorityGrantLifecycleError,
  DoctrineAuditEventMismatchError,
  SqliteStore,
  ProtectedStateTransitionError,
  TransitionEventMismatchError,
} from "../../src/storage/sqlite/index.js";

const MISSION_ID = "00000000-0000-4000-8000-000000000001";
const TASK_ID = "00000000-0000-4000-8000-000000000002";
const REPORT_ID = "00000000-0000-4000-8000-000000000003";
const DECISION_ID = "00000000-0000-4000-8000-000000000004";
const CREATED_EVENT_ID = "00000000-0000-4000-8000-000000000005";
const TRANSITION_EVENT_ID = "00000000-0000-4000-8000-000000000006";
const GRANT_EVENT_ID = "00000000-0000-4000-8000-000000000007";
const REVOKE_EVENT_ID = "00000000-0000-4000-8000-000000000008";
const EXPIRE_EVENT_ID = "00000000-0000-4000-8000-000000000009";
const AUTHORIZATION_EVENT_ID = "00000000-0000-4000-8000-000000000010";
const VIOLATION_EVENT_ID = "00000000-0000-4000-8000-000000000011";
const ESCALATION_EVENT_ID = "00000000-0000-4000-8000-000000000012";
const ESCALATION_RESOLVED_EVENT_ID = "00000000-0000-4000-8000-000000000013";
const SECOND_GRANT_EVENT_ID = "00000000-0000-4000-8000-000000000014";
const PRE_MISSION_EVENT_ID = "00000000-0000-4000-8000-000000000015";
const CONSTRAINT_EVENT_ID = "00000000-0000-4000-8000-000000000016";
const COMPOSITE_AUTH_EVENT_ID = "00000000-0000-4000-8000-000000000017";
const RELATED_VIOLATION_EVENT_ID = "00000000-0000-4000-8000-000000000018";
const GRANT_ID = "grant-01";
const EXPIRING_GRANT_ID = "grant-expiring-01";
const AUTHORIZATION_ID = "authorization-01";
const VIOLATION_ID = "violation-01";
const ESCALATION_ID = "escalation-01";

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

async function missionPermit(
  store: SqliteStore,
  from: Mission["status"],
  to: Mission["status"],
  transitionEvent: Event,
  missionId = MISSION_ID,
) {
  const request = {
    id: `request-${transitionEvent.id}`,
    actorId: "runtime",
    role: "runtime" as const,
    missionId,
    decisionType: "state.transition" as const,
    action: "state.transition",
    context: { entity: "mission", entityId: missionId, from, to },
    createdAt: transitionEvent.createdAt,
  };
  const authorization = await new DoctrineEnforcer(store, {
    now: () => transitionEvent.createdAt,
  }).authorize(request);
  assert.equal(authorization.result, "allow");
  return issueRuntimeTransitionPermit(request, authorization, transitionEvent);
}

async function taskPermit(
  store: SqliteStore,
  from: Task["status"],
  to: Task["status"],
  transitionEvent: Event,
  evidence?: { readonly reportId: string },
) {
  const request = {
    id: `request-${transitionEvent.id}`,
    actorId: "runtime",
    role: "runtime" as const,
    missionId: MISSION_ID,
    taskId: TASK_ID,
    decisionType: "state.transition" as const,
    action: "state.transition",
    context: {
      entity: "task",
      entityId: TASK_ID,
      from,
      to,
      ...(from === "pending" && to === "running"
        ? { assignedAgentId: "mock-worker", attempts: 1 }
        : {}),
      ...(evidence === undefined
        ? {}
        : { evaluationResult: "pass", reportId: evidence.reportId }),
    },
    createdAt: transitionEvent.createdAt,
  };
  const authorization = await new DoctrineEnforcer(store, {
    now: () => transitionEvent.createdAt,
  }).authorize(request);
  assert.equal(authorization.result, "allow");
  return issueRuntimeTransitionPermit(request, authorization, transitionEvent);
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

function constraint(): Constraint {
  return {
    id: "constraint-01",
    sourceId: "lead-01",
    kind: "prohibit",
    target: "public_api.modify",
    scope: { type: "path", pattern: "src/**" },
    inherited: true,
  };
}

function riskLimit(): RiskLimit {
  return {
    dimension: "retry_count",
    operator: "lte",
    value: 3,
  };
}

function authorityGrant(
  id = GRANT_ID,
  expiresAt = new Date("2026-08-19T01:00:00.000Z"),
): AuthorityGrant {
  return {
    id,
    issuerId: "lead-01",
    subjectId: "mock-worker",
    missionId: MISSION_ID,
    taskId: TASK_ID,
    permissions: [
      {
        action: "code.edit",
        resource: { type: "path", pattern: "src/**" },
      },
    ],
    constraints: [constraint()],
    riskLimits: [riskLimit()],
    status: "active",
    createdAt: new Date("2026-08-19T00:02:30.000Z"),
    expiresAt,
  };
}

function authorizationRecord(): AuthorizationRecord {
  return {
    id: AUTHORIZATION_ID,
    requestId: "request-01",
    missionId: MISSION_ID,
    taskId: TASK_ID,
    actorId: "mock-worker",
    decisionType: "execution.method.select",
    result: "allow",
    reason: "Worker owns implementation method selection",
    createdAt: new Date("2026-08-19T00:07:00.000Z"),
  };
}

function doctrineViolationRecord(): DoctrineViolationRecord {
  return {
    id: VIOLATION_ID,
    requestId: "request-02",
    missionId: MISSION_ID,
    taskId: TASK_ID,
    code: "COMMAND_BOUNDARY_VIOLATION",
    actorId: "mock-worker",
    decisionType: "goal.modify",
    message: "Worker cannot modify the Goal",
    createdAt: new Date("2026-08-19T00:08:00.000Z"),
  };
}

function escalationRecord(status: EscalationRecord["status"] = "open"): EscalationRecord {
  return {
    id: ESCALATION_ID,
    missionId: MISSION_ID,
    taskId: TASK_ID,
    requesterId: "mock-worker",
    decisionType: "mission.scope.modify",
    reason: "The task requires a mission scope decision",
    requestedChange: { include: "src/shared/**" },
    targetRole: "commander",
    status,
    createdAt: new Date("2026-08-19T00:09:00.000Z"),
    ...(status === "resolved"
      ? { resolvedAt: new Date("2026-08-19T00:10:00.000Z") }
      : {}),
  };
}

function grantAuthorization(id = "authorization-grant"): AuthorizationRecord {
  return {
    id,
    requestId: "request-grant",
    missionId: MISSION_ID,
    taskId: TASK_ID,
    actorId: "lead-01",
    decisionType: "authority.delegate",
    result: "allow",
    reason: "Delegation is a valid narrowing",
    createdAt: new Date("2026-08-19T00:03:20.000Z"),
  };
}

function revocationAuthorization(id = "authorization-revoke"): AuthorizationRecord {
  return {
    id,
    requestId: "request-revoke",
    missionId: MISSION_ID,
    taskId: TASK_ID,
    actorId: "lead-01",
    decisionType: "authority.revoke",
    result: "allow",
    reason: "The issuer revoked the grant",
    createdAt: new Date("2026-08-19T00:04:00.000Z"),
  };
}

function escalationAuthorization(
  status: EscalationRecord["status"],
  id = `authorization-escalation-${status}`,
): AuthorizationRecord {
  return {
    id,
    requestId: `request-escalation-${status}`,
    missionId: MISSION_ID,
    taskId: TASK_ID,
    actorId: status === "open" ? "mock-worker" : "commander-01",
    decisionType: "mission.scope.modify",
    result: status === "open" ? "escalate" : "allow",
    reason: status === "open" ? escalationRecord().reason : "Approved",
    ...(status === "open" ? { targetRole: "commander" as const } : {}),
    createdAt: status === "open"
      ? new Date("2026-08-19T00:09:10.000Z")
      : new Date("2026-08-19T00:10:10.000Z"),
  };
}

function denialAuthorization(
  violation = doctrineViolationRecord(),
  id = "authorization-deny",
): AuthorizationRecord {
  return {
    id,
    requestId: violation.requestId,
    missionId: violation.missionId,
    ...(violation.taskId === undefined ? {} : { taskId: violation.taskId }),
    actorId: violation.actorId,
    decisionType: violation.decisionType,
    result: "deny",
    reason: violation.message,
    violation,
    createdAt: new Date("2026-08-19T00:08:10.000Z"),
  };
}

describe("SQLiteストア", () => {
  it("必要なすべてのテーブルを永続化し、JSONの日付を復元する", () => {
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

  it("有効な状態とイベントの遷移をアトミックにコミットする", async () => {
    const store = new SqliteStore();
    try {
      store.saveMission(mission());
      store.saveTask({ ...task(), assignedAgentId: "mock-worker" });
      store.saveAgent(agent());

      const planningEvent = event(TRANSITION_EVENT_ID, "MissionPlanning");
      const transitionedMission = store.transitionMission(
        MISSION_ID,
        "planning",
        planningEvent,
        await missionPermit(store, "created", "planning", planningEvent),
      );
      assert.equal(transitionedMission.status, "planning");
      assert.equal(store.getMission(MISSION_ID)?.status, "planning");
      assert.equal(
        store.listEvents(MISSION_ID).filter(({ type }) => type === "MissionPlanning").length,
        1,
      );

      const taskEvent = event(
        "00000000-0000-4000-8000-000000000007",
        "TaskStarted",
        new Date("2026-08-19T00:06:00.000Z"),
      );
      const transitionedTask = store.transitionTask(
        TASK_ID,
        "running",
        taskEvent,
        await taskPermit(store, "pending", "running", taskEvent),
      );
      assert.equal(transitionedTask.status, "running");
      assert.equal(store.getTask(TASK_ID)?.status, "running");
      assert.equal(
        store.listEvents(MISSION_ID).filter(({ type }) => type === "TaskStarted").length,
        1,
      );
    } finally {
      store.close();
    }
  });

  it("イベントの追加に失敗したとき状態の更新をロールバックする", async () => {
    const store = new SqliteStore();
    try {
      store.saveMission(mission());
      store.appendEvent(event(CREATED_EVENT_ID, "MissionCreated"));

      const duplicateEvent = event(CREATED_EVENT_ID, "MissionPlanning");
      const duplicatePermit = await missionPermit(
        store,
        "created",
        "planning",
        duplicateEvent,
      );
      assert.throws(
        () => store.transitionMission(
          MISSION_ID,
          "planning",
          duplicateEvent,
          duplicatePermit,
        ),
        /UNIQUE constraint failed: events.id/,
      );
      assert.equal(store.getMission(MISSION_ID)?.status, "created");
      assert.equal(
        store.listEvents(MISSION_ID).filter(({ type }) => type === "MissionPlanning").length,
        0,
      );
    } finally {
      store.close();
    }
  });

  it("認可permitなしのpublic状態遷移を永続状態・イベント不変のまま拒否する", () => {
    const store = new SqliteStore();
    try {
      store.saveMission(mission());
      store.saveTask(task());
      store.saveAgent(agent());
      const directEvent = event(TRANSITION_EVENT_ID, "MissionPlanning");
      const fabricatedRequest = {
        id: "fabricated-transition-request",
        actorId: "runtime",
        role: "runtime" as const,
        missionId: MISSION_ID,
        decisionType: "state.transition" as const,
        action: "state.transition",
        context: {
          entity: "mission",
          entityId: MISSION_ID,
          from: "created",
          to: "planning",
        },
        createdAt: directEvent.createdAt,
      };
      assert.throws(
        () => issueRuntimeTransitionPermit(
          fabricatedRequest,
          { result: "allow", reason: "fabricated" },
          directEvent,
        ),
        ProtectedStateTransitionError,
      );
      assert.throws(
        () => store.transitionMission(
          MISSION_ID,
          "planning",
          directEvent,
        ),
        ProtectedStateTransitionError,
      );
      assert.throws(
        () => store.transitionTask(
          TASK_ID,
          "running",
          event(GRANT_EVENT_ID, "TaskStarted"),
        ),
        ProtectedStateTransitionError,
      );
      assert.throws(
        () => store.assignTaskAndEvent(
          TASK_ID,
          "mock-worker",
          event(AUTHORIZATION_EVENT_ID, "TaskAssigned"),
        ),
        ProtectedStateTransitionError,
      );
      assert.equal(store.getMission(MISSION_ID)?.status, "created");
      assert.equal(store.getTask(TASK_ID)?.status, "pending");
      assert.equal(store.getTask(TASK_ID)?.assignedAgentId, undefined);
      assert.deepEqual(store.listEvents(MISSION_ID), []);
      assert.deepEqual(store.listReports(MISSION_ID, TASK_ID), []);
    } finally {
      store.close();
    }
  });

  it("完了時点でEvaluatorではないactorのPASS証跡をStoreも拒否する", async () => {
    const store = new SqliteStore();
    try {
      store.saveMission(mission("evaluating"));
      store.saveTask(task("evaluating"));
      store.saveReport(report());
      const evaluator: AgentRecord = {
        ...agent(),
        id: "mock-evaluator",
        name: "Mock Evaluator",
        role: "evaluator",
      };
      store.saveAgent(evaluator);
      store.appendEvent({
        ...event(CREATED_EVENT_ID, "EvaluationPassed"),
        actor: evaluator.id,
        payload: { taskId: TASK_ID, reportId: REPORT_ID },
      });
      const completionEvent = event(TRANSITION_EVENT_ID, "TaskCompleted");
      const permit = await taskPermit(
        store,
        "evaluating",
        "completed",
        completionEvent,
        { reportId: REPORT_ID },
      );
      // The permit was genuine, but the durable actor role no longer supports
      // the claimed evidence when the Store performs its final check.
      store.saveAgent({ ...evaluator, role: "worker" });
      assert.throws(
        () => store.transitionTask(
          TASK_ID,
          "completed",
          completionEvent,
          permit,
        ),
        ProtectedStateTransitionError,
      );
      assert.equal(store.getTask(TASK_ID)?.status, "evaluating");
      assert.equal(store.listReports(MISSION_ID, TASK_ID).length, 1);
      assert.equal(
        store.listEvents(MISSION_ID).filter(({ type }) => type === "EvaluationPassed").length,
        1,
      );
    } finally {
      store.close();
    }
  });

  it("不正な遷移と一致しない遷移イベントを変更なしで拒否する", () => {
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

      assert.throws(
        () => store.saveMission({
          ...mission("completed"),
          goal: "Illegitimate same-status rewrite",
        }),
        DirectStateMutationError,
      );
      assert.throws(
        () => store.saveTask({
          ...task("completed"),
          objective: "Illegitimate same-status rewrite",
        }),
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

  it("イベントが拒否されたときエンティティとイベントの対になった書き込みをロールバックする", () => {
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
        DirectStateMutationError,
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

  it("プロセス再起動を想定した再オープン後に完全なミッションスナップショットを復元する", () => {
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

  it("重複識別子を拒否してイベントを追記専用に保つ", () => {
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

  it("直接のSQL更新と削除に対してイベントの追記専用性を強制する", () => {
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

  it("Authority GrantとConstraint、Risk Limitを永続化して検索可能にする", () => {
    const store = new SqliteStore();
    try {
      store.saveMission(mission());
      store.saveTask(task());
      const grant = authorityGrant();
      store.grantAuthority(
        grant,
        event(
          GRANT_EVENT_ID,
          "AuthorityGranted",
          new Date("2026-08-19T00:03:00.000Z"),
        ),
      );

      const restored = store.getAuthorityGrant(GRANT_ID);
      assert.equal(restored?.status, "active");
      assert.ok(restored?.createdAt instanceof Date);
      assert.ok(restored?.expiresAt instanceof Date);
      assert.deepEqual(store.listAuthorityGrants(MISSION_ID, "mock-worker"), [grant]);
      assert.deepEqual(store.listAuthorityGrants(MISSION_ID, "another-worker"), []);
      assert.deepEqual(store.listConstraints(MISSION_ID, "mock-worker"), [constraint()]);
      assert.deepEqual(store.listRiskLimits(MISSION_ID, "mock-worker"), [riskLimit()]);

      const snapshot = store.loadMissionSnapshot(MISSION_ID);
      assert.deepEqual(snapshot?.authorityGrants, [grant]);
      assert.deepEqual(snapshot?.constraints, [constraint()]);
      assert.deepEqual(snapshot?.riskLimits, [riskLimit()]);
      assert.deepEqual(snapshot?.events.map(({ type }) => type), ["AuthorityGranted"]);
    } finally {
      store.close();
    }
  });

  it("Authority Grantの取消と期限切れを監査イベントとアトミックに確定する", () => {
    const store = new SqliteStore();
    try {
      store.saveMission(mission());
      store.saveTask(task());
      store.grantAuthority(
        authorityGrant(),
        event(
          GRANT_EVENT_ID,
          "AuthorityGranted",
          new Date("2026-08-19T00:03:00.000Z"),
        ),
      );

      const revokedAt = new Date("2026-08-19T00:04:00.000Z");
      const revoked = store.revokeAuthorityGrant(
        GRANT_ID,
        revokedAt,
        event(REVOKE_EVENT_ID, "AuthorityRevoked", revokedAt),
      );
      assert.equal(revoked.status, "revoked");
      assert.deepEqual(revoked.revokedAt, revokedAt);
      assert.throws(
        () => store.revokeAuthorityGrant(
          GRANT_ID,
          revokedAt,
          event(SECOND_GRANT_EVENT_ID, "AuthorityRevoked", revokedAt),
        ),
        AuthorityGrantLifecycleError,
      );

      const expiresAt = new Date("2026-08-19T00:06:00.000Z");
      store.grantAuthority(
        authorityGrant(EXPIRING_GRANT_ID, expiresAt),
        event(
          SECOND_GRANT_EVENT_ID,
          "AuthorityGranted",
          new Date("2026-08-19T00:03:30.000Z"),
        ),
      );
      assert.throws(
        () => store.expireAuthorityGrant(
          EXPIRING_GRANT_ID,
          event(
            EXPIRE_EVENT_ID,
            "AuthorityExpired",
            new Date("2026-08-19T00:05:59.999Z"),
          ),
        ),
        AuthorityGrantLifecycleError,
      );
      assert.equal(store.getAuthorityGrant(EXPIRING_GRANT_ID)?.status, "active");

      const expired = store.expireAuthorityGrant(
        EXPIRING_GRANT_ID,
        event(EXPIRE_EVENT_ID, "AuthorityExpired", expiresAt),
      );
      assert.equal(expired.status, "expired");
      assert.deepEqual(
        store.listEvents(MISSION_ID).map(({ type }) => type),
        [
          "AuthorityGranted",
          "AuthorityGranted",
          "AuthorityRevoked",
          "AuthorityExpired",
        ],
      );
    } finally {
      store.close();
    }
  });

  it("監査イベントが拒否された場合はAuthority Grantの状態変更もロールバックする", () => {
    const store = new SqliteStore();
    try {
      store.saveMission(mission());
      store.saveTask(task());
      store.grantAuthority(
        authorityGrant(),
        event(
          GRANT_EVENT_ID,
          "AuthorityGranted",
          new Date("2026-08-19T00:03:00.000Z"),
        ),
      );
      const revokedAt = new Date("2026-08-19T00:04:00.000Z");
      assert.throws(
        () => store.revokeAuthorityGrant(
          GRANT_ID,
          revokedAt,
          event(GRANT_EVENT_ID, "AuthorityRevoked", revokedAt),
        ),
        /UNIQUE constraint failed: events.id/,
      );
      assert.equal(store.getAuthorityGrant(GRANT_ID)?.status, "active");
      assert.equal(store.listEvents(MISSION_ID).length, 1);

      assert.throws(
        () => store.grantAuthority(
          authorityGrant("grant-mismatch"),
          event(SECOND_GRANT_EVENT_ID, "AuthorityRevoked"),
        ),
        DoctrineAuditEventMismatchError,
      );
      assert.equal(store.getAuthorityGrant("grant-mismatch"), undefined);
    } finally {
      store.close();
    }
  });

  it("Grant、Constraint、Authorization監査を単一トランザクションで確定する", () => {
    const store = new SqliteStore();
    try {
      store.saveMission(mission());
      store.saveTask(task());
      const grant = authorityGrant();
      const authorization = grantAuthorization();
      store.grantAuthorityWithAudit({
        grant,
        grantEvent: {
          ...event(
            GRANT_EVENT_ID,
            "AuthorityGranted",
            new Date("2026-08-19T00:03:00.000Z"),
          ),
          payload: { grantId: grant.id, subjectId: grant.subjectId },
        },
        constraintEvents: [
          {
            ...event(
              CONSTRAINT_EVENT_ID,
              "ConstraintApplied",
              new Date("2026-08-19T00:03:10.000Z"),
            ),
            payload: {
              grantId: grant.id,
              constraintId: constraint().id,
              subjectId: grant.subjectId,
            },
          },
        ],
        authorization: {
          record: authorization,
          event: {
            ...event(
              COMPOSITE_AUTH_EVENT_ID,
              "AuthorizationAllowed",
              authorization.createdAt,
            ),
            payload: { requestId: authorization.requestId },
          },
        },
      });

      assert.deepEqual(store.getAuthorityGrant(grant.id), grant);
      assert.deepEqual(store.listConstraints(MISSION_ID), [constraint()]);
      assert.deepEqual(store.listRiskLimits(MISSION_ID), [riskLimit()]);
      assert.deepEqual(store.listAuthorizationRecords(MISSION_ID), [authorization]);
      assert.deepEqual(
        store.listEvents(MISSION_ID).map(({ type }) => type),
        ["AuthorityGranted", "ConstraintApplied", "AuthorizationAllowed"],
      );
    } finally {
      store.close();
    }
  });

  it("後段Authorization失敗時にGrant、Constraint、Risk、Eventを全てロールバックする", () => {
    const store = new SqliteStore();
    try {
      store.saveMission(mission());
      store.saveTask(task());
      const grant = authorityGrant();
      const authorization = grantAuthorization();
      store.saveAuthorizationRecordAndEvent(
        authorization,
        event(
          AUTHORIZATION_EVENT_ID,
          "AuthorizationAllowed",
          authorization.createdAt,
        ),
      );

      assert.throws(
        () => store.grantAuthorityWithAudit({
          grant,
          grantEvent: {
            ...event(
              GRANT_EVENT_ID,
              "AuthorityGranted",
              new Date("2026-08-19T00:03:00.000Z"),
            ),
            payload: { grantId: grant.id },
          },
          constraintEvents: [
            {
              ...event(
                CONSTRAINT_EVENT_ID,
                "ConstraintApplied",
                new Date("2026-08-19T00:03:10.000Z"),
              ),
              payload: {
                grantId: grant.id,
                constraintId: constraint().id,
              },
            },
          ],
          authorization: {
            record: authorization,
            event: {
              ...event(
                COMPOSITE_AUTH_EVENT_ID,
                "AuthorizationAllowed",
                authorization.createdAt,
              ),
              payload: { requestId: authorization.requestId },
            },
          },
        }),
        /UNIQUE constraint failed: authorization_results.id/,
      );

      assert.equal(store.getAuthorityGrant(grant.id), undefined);
      assert.deepEqual(store.listConstraints(MISSION_ID), []);
      assert.deepEqual(store.listRiskLimits(MISSION_ID), []);
      assert.deepEqual(
        store.listEvents(MISSION_ID).map(({ type }) => type),
        ["AuthorizationAllowed"],
      );
    } finally {
      store.close();
    }
  });

  it("後段Authorization失敗時にGrant取消とAuthorityRevoked Eventをロールバックする", () => {
    const store = new SqliteStore();
    try {
      store.saveMission(mission());
      store.saveTask(task());
      const grant = authorityGrant();
      store.grantAuthority(
        grant,
        event(
          GRANT_EVENT_ID,
          "AuthorityGranted",
          new Date("2026-08-19T00:03:00.000Z"),
        ),
      );
      const authorization = revocationAuthorization();
      store.saveAuthorizationRecordAndEvent(
        authorization,
        event(
          AUTHORIZATION_EVENT_ID,
          "AuthorizationAllowed",
          authorization.createdAt,
        ),
      );

      assert.throws(
        () => store.revokeAuthorityGrantWithAudit({
          grantId: grant.id,
          revokedAt: authorization.createdAt,
          revokeEvent: {
            ...event(
              REVOKE_EVENT_ID,
              "AuthorityRevoked",
              authorization.createdAt,
            ),
            payload: { grantId: grant.id },
          },
          authorization: {
            record: authorization,
            event: {
              ...event(
                COMPOSITE_AUTH_EVENT_ID,
                "AuthorizationAllowed",
                authorization.createdAt,
              ),
              payload: { requestId: authorization.requestId },
            },
          },
        }),
        /UNIQUE constraint failed: authorization_results.id/,
      );

      assert.equal(store.getAuthorityGrant(grant.id)?.status, "active");
      assert.equal(
        store.listEvents(MISSION_ID).some(({ type }) => type === "AuthorityRevoked"),
        false,
      );
    } finally {
      store.close();
    }
  });

  it("後段Authorization失敗時にEscalation作成と解決ledgerをロールバックする", () => {
    const store = new SqliteStore();
    try {
      store.saveMission(mission());
      store.saveTask(task());
      const open = escalationRecord("open");
      const openAuthorization = escalationAuthorization("open");
      store.saveAuthorizationRecordAndEvent(
        openAuthorization,
        event(
          AUTHORIZATION_EVENT_ID,
          "AuthorizationEscalated",
          openAuthorization.createdAt,
        ),
      );
      assert.throws(
        () => store.saveEscalationWithAudit({
          escalation: open,
          escalationEvent: {
            ...event(
              ESCALATION_EVENT_ID,
              "EscalationCreated",
              open.createdAt,
            ),
            payload: { escalationId: open.id },
          },
          authorization: {
            record: openAuthorization,
            event: {
              ...event(
                COMPOSITE_AUTH_EVENT_ID,
                "AuthorizationEscalated",
                openAuthorization.createdAt,
              ),
              payload: { requestId: openAuthorization.requestId },
            },
          },
        }),
        /UNIQUE constraint failed: authorization_results.id/,
      );
      assert.equal(store.getEscalation(open.id), undefined);

      store.saveEscalationAndEvent(
        open,
        event(ESCALATION_EVENT_ID, "EscalationCreated", open.createdAt),
      );
      const resolved = escalationRecord("resolved");
      const resolvedAuthorization = escalationAuthorization("resolved");
      store.saveAuthorizationRecordAndEvent(
        resolvedAuthorization,
        event(
          SECOND_GRANT_EVENT_ID,
          "AuthorizationAllowed",
          resolvedAuthorization.createdAt,
        ),
      );
      assert.throws(
        () => store.saveEscalationWithAudit({
          escalation: resolved,
          escalationEvent: {
            ...event(
              ESCALATION_RESOLVED_EVENT_ID,
              "EscalationResolved",
              resolved.resolvedAt!,
            ),
            payload: { escalationId: resolved.id },
          },
          authorization: {
            record: resolvedAuthorization,
            event: {
              ...event(
                PRE_MISSION_EVENT_ID,
                "AuthorizationAllowed",
                resolvedAuthorization.createdAt,
              ),
              payload: { requestId: resolvedAuthorization.requestId },
            },
          },
        }),
        /UNIQUE constraint failed: authorization_results.id/,
      );
      assert.equal(store.getEscalation(open.id)?.status, "open");
      assert.deepEqual(store.listEscalations(MISSION_ID), [open]);
      assert.equal(
        store.listEvents(MISSION_ID).some(({ type }) => type === "EscalationResolved"),
        false,
      );
    } finally {
      store.close();
    }
  });

  it("後段Authorization失敗時にViolationと関連Eventを全てロールバックする", () => {
    const store = new SqliteStore();
    try {
      store.saveMission(mission());
      store.saveTask(task());
      const violation = doctrineViolationRecord();
      const authorization = denialAuthorization(violation);
      store.saveAuthorizationRecordAndEvent(
        authorization,
        event(
          AUTHORIZATION_EVENT_ID,
          "AuthorizationDenied",
          authorization.createdAt,
        ),
      );

      assert.throws(
        () => store.saveDoctrineDenialAudit({
          violation,
          violationEvent: {
            ...event(
              VIOLATION_EVENT_ID,
              "DoctrineViolationDetected",
              violation.createdAt,
            ),
            payload: { violationId: violation.id },
          },
          relatedEvents: [
            {
              ...event(
                RELATED_VIOLATION_EVENT_ID,
                "ConstraintViolationDetected",
                new Date("2026-08-19T00:08:05.000Z"),
              ),
              payload: { violationId: violation.id },
            },
          ],
          authorization: {
            record: authorization,
            event: {
              ...event(
                COMPOSITE_AUTH_EVENT_ID,
                "AuthorizationDenied",
                authorization.createdAt,
              ),
              payload: { requestId: authorization.requestId },
            },
          },
        }),
        /UNIQUE constraint failed: authorization_results.id/,
      );

      assert.deepEqual(store.listDoctrineViolations(MISSION_ID), []);
      assert.deepEqual(
        store.listEvents(MISSION_ID).map(({ type }) => type),
        ["AuthorizationDenied"],
      );
    } finally {
      store.close();
    }
  });

  it("Authorization結果、Doctrine違反、Escalationを追記専用監査として保持する", () => {
    const directory = mkdtempSync(join(tmpdir(), "cc-runtime-doctrine-audit-"));
    const databasePath = join(directory, "runtime.sqlite");
    try {
      const store = new SqliteStore(databasePath);
      store.saveMission(mission());
      store.saveTask(task());
      store.grantAuthority(
        authorityGrant(),
        event(
          GRANT_EVENT_ID,
          "AuthorityGranted",
          new Date("2026-08-19T00:03:00.000Z"),
        ),
      );
      store.saveAuthorizationRecordAndEvent(
        authorizationRecord(),
        event(
          AUTHORIZATION_EVENT_ID,
          "AuthorizationAllowed",
          new Date("2026-08-19T00:07:00.000Z"),
        ),
      );
      store.saveDoctrineViolationAndEvent(
        doctrineViolationRecord(),
        event(
          VIOLATION_EVENT_ID,
          "DoctrineViolationDetected",
          new Date("2026-08-19T00:08:00.000Z"),
        ),
      );
      const openEscalation = escalationRecord();
      store.saveEscalationAndEvent(
        openEscalation,
        event(
          ESCALATION_EVENT_ID,
          "EscalationCreated",
          openEscalation.createdAt,
        ),
      );
      const resolvedEscalation = escalationRecord("resolved");
      store.saveEscalationAndEvent(
        resolvedEscalation,
        event(
          ESCALATION_RESOLVED_EVENT_ID,
          "EscalationResolved",
          resolvedEscalation.resolvedAt,
        ),
      );
      store.close();

      const database = new DatabaseSync(databasePath);
      try {
        for (const [table, message] of [
          ["constraints", "constraints are append-only"],
          ["risk_limits", "risk limits are append-only"],
          ["authorization_results", "authorization results are append-only"],
          ["doctrine_violations", "doctrine violations are append-only"],
          ["escalations", "escalations are append-only"],
        ] as const) {
          assert.throws(
            () => database.prepare(`UPDATE ${table} SET data = data`).run(),
            new RegExp(message),
          );
          assert.throws(
            () => database.prepare(`DELETE FROM ${table}`).run(),
            new RegExp(message),
          );
        }
        assert.throws(
          () => database.prepare("DELETE FROM authority_grants").run(),
          /authority grants are retained for audit/,
        );
      } finally {
        database.close();
      }

      const reader = new SqliteStore(databasePath);
      try {
        assert.equal(reader.getAuthorityGrant(GRANT_ID)?.status, "active");
        assert.ok(reader.getAuthorityGrant(GRANT_ID)?.expiresAt instanceof Date);
        assert.deepEqual(reader.listConstraints(MISSION_ID), [constraint()]);
        assert.deepEqual(reader.listRiskLimits(MISSION_ID), [riskLimit()]);
        assert.deepEqual(reader.listAuthorizationRecords(MISSION_ID), [
          authorizationRecord(),
        ]);
        assert.deepEqual(reader.listDoctrineViolations(MISSION_ID), [
          doctrineViolationRecord(),
        ]);
        assert.deepEqual(reader.listEscalations(MISSION_ID), [
          openEscalation,
          resolvedEscalation,
        ]);
        assert.deepEqual(reader.getEscalation(ESCALATION_ID), resolvedEscalation);
        assert.ok(reader.getEscalation(ESCALATION_ID)?.resolvedAt instanceof Date);
        assert.deepEqual(
          reader.listEvents(MISSION_ID).map(({ type }) => type),
          [
            "AuthorityGranted",
            "AuthorizationAllowed",
            "DoctrineViolationDetected",
            "EscalationCreated",
            "EscalationResolved",
          ],
        );
      } finally {
        reader.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("Mission作成前のDecisionとAuthorization監査を相関IDで保存できる", () => {
    const store = new SqliteStore();
    const prospectiveMissionId = "00000000-0000-4000-8000-999999999999";
    try {
      const { taskId: _taskId, ...baseRecord } = authorizationRecord();
      const record: AuthorizationRecord = {
        ...baseRecord,
        missionId: prospectiveMissionId,
        decisionType: "mission.create",
        actorId: "commander-01",
        reason: "Commander owns mission creation",
      };
      const authorizationEvent = {
        ...event(
          AUTHORIZATION_EVENT_ID,
          "AuthorizationAllowed",
          record.createdAt,
        ),
        missionId: prospectiveMissionId,
      };
      store.appendEvent({
        ...event(PRE_MISSION_EVENT_ID, "DecisionRequested"),
        missionId: prospectiveMissionId,
      });
      store.saveAuthorizationRecordAndEvent(record, authorizationEvent);

      assert.deepEqual(store.listAuthorizationRecords(prospectiveMissionId), [record]);
      assert.deepEqual(
        store.listEvents(prospectiveMissionId).map(({ type }) => type),
        ["DecisionRequested", "AuthorizationAllowed"],
      );
      assert.equal(store.getMission(prospectiveMissionId), undefined);
    } finally {
      store.close();
    }
  });

  it("v1のEvent履歴を順序と追記専用性を保ったまま相関ID方式へ移行する", () => {
    const directory = mkdtempSync(join(tmpdir(), "cc-runtime-v1-migration-"));
    const databasePath = join(directory, "runtime.sqlite");
    const firstEvent = event(
      CREATED_EVENT_ID,
      "MissionCreated",
      new Date("2026-08-19T00:05:00.000Z"),
    );
    const secondEvent = event(
      TRANSITION_EVENT_ID,
      "MissionPlanningStarted",
      new Date("2026-08-19T00:05:00.000Z"),
    );

    try {
      const legacy = new DatabaseSync(databasePath, {
        enableForeignKeyConstraints: true,
      });
      try {
        legacy.exec(`
          CREATE TABLE missions (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            data TEXT NOT NULL
          ) STRICT;
          CREATE TABLE events (
            id TEXT PRIMARY KEY,
            mission_id TEXT NOT NULL REFERENCES missions(id),
            type TEXT NOT NULL,
            actor TEXT,
            created_at TEXT NOT NULL,
            data TEXT NOT NULL
          ) STRICT;
          CREATE INDEX events_by_mission
            ON events(mission_id, created_at, id);
          CREATE TRIGGER events_are_append_only_on_update
          BEFORE UPDATE ON events BEGIN
            SELECT RAISE(ABORT, 'events are append-only');
          END;
          CREATE TRIGGER events_are_append_only_on_delete
          BEFORE DELETE ON events BEGIN
            SELECT RAISE(ABORT, 'events are append-only');
          END;
          PRAGMA user_version = 1;
        `);
        const legacyMission = mission();
        legacy.prepare(`
          INSERT INTO missions (id, status, created_at, updated_at, data)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          legacyMission.id,
          legacyMission.status,
          legacyMission.createdAt.toISOString(),
          legacyMission.updatedAt.toISOString(),
          JSON.stringify(legacyMission),
        );
        const insertEvent = legacy.prepare(`
          INSERT INTO events (id, mission_id, type, actor, created_at, data)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const legacyEvent of [firstEvent, secondEvent]) {
          insertEvent.run(
            legacyEvent.id,
            legacyEvent.missionId,
            legacyEvent.type,
            legacyEvent.actor ?? null,
            legacyEvent.createdAt.toISOString(),
            JSON.stringify(legacyEvent),
          );
        }
      } finally {
        legacy.close();
      }

      const migrated = new SqliteStore(databasePath);
      try {
        assert.deepEqual(migrated.listEvents(MISSION_ID), [firstEvent, secondEvent]);
        migrated.appendEvent({
          ...event(PRE_MISSION_EVENT_ID, "DecisionRequested"),
          missionId: "00000000-0000-4000-8000-999999999999",
        });
      } finally {
        migrated.close();
      }

      const database = new DatabaseSync(databasePath);
      try {
        const version = database.prepare("PRAGMA user_version").get() as {
          user_version: number;
        };
        assert.equal(version.user_version, 2);
        assert.equal(database.prepare("PRAGMA foreign_key_list(events)").all().length, 0);
        assert.throws(
          () => database.prepare("DELETE FROM events").run(),
          /events are append-only/,
        );
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
