import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import type {
  DecisionRequest,
  DecisionType,
} from "../../src/domain/index.js";
import { DoctrineEnforcer } from "../../src/runtime/doctrine/index.js";
import { MISSION_ID, TASK_ID, TestDoctrineStore } from "./test-store.js";

const NOW = new Date("2026-08-20T01:00:00.000Z");

function evaluatorRequest(decisionType: DecisionType): DecisionRequest {
  return {
    id: randomUUID(),
    actorId: "evaluator-01",
    role: "evaluator",
    missionId: MISSION_ID,
    taskId: TASK_ID,
    decisionType,
    action: decisionType,
    createdAt: NOW,
  };
}

function runtimeTransition(
  entity: "mission" | "task",
  from: string,
  to: string,
  evaluationResult?: "pass" | "fail",
  reportId?: string,
): DecisionRequest {
  return {
    id: randomUUID(),
    actorId: "runtime",
    role: "runtime",
    missionId: MISSION_ID,
    ...(entity === "task" ? { taskId: TASK_ID } : {}),
    decisionType: "state.transition",
    action: "state.transition",
    context: {
      entity,
      from,
      to,
      ...(evaluationResult === undefined ? {} : { evaluationResult }),
      ...(reportId === undefined ? {} : { reportId }),
    },
    createdAt: NOW,
  };
}

describe("Evaluator isolation", () => {
  it("allows independent PASS, FAIL, and recommendation decisions", async () => {
    const store = new TestDoctrineStore();
    const enforcer = new DoctrineEnforcer(store);
    for (const decisionType of [
      "evaluation.pass",
      "evaluation.fail",
      "evaluation.recommend",
    ] as const) {
      assert.equal(
        (await enforcer.authorize(evaluatorRequest(decisionType))).result,
        "allow",
      );
    }
    assert.equal(store.events.some(({ type }) => type === "TaskCompleted"), false);
  });

  it("denies evaluator command and state mutation attempts", async () => {
    const store = new TestDoctrineStore();
    const enforcer = new DoctrineEnforcer(store);
    const state = await enforcer.authorize({
      ...evaluatorRequest("state.transition"),
      context: { entity: "task", from: "evaluating", to: "completed" },
    });
    const scope = await enforcer.authorize(
      evaluatorRequest("mission.scope.modify"),
    );
    const task = await enforcer.authorize(evaluatorRequest("task.modify"));

    assert.equal(state.result, "deny");
    assert.equal(
      state.result === "deny" && state.violation.code,
      "EVALUATOR_STATE_MUTATION",
    );
    assert.equal(scope.result, "deny");
    assert.equal(task.result, "deny");
  });
});

describe("Doctrine/state-machine composition", () => {
  it("allows only valid runtime transitions and requires PASS for completion", async () => {
    const store = new TestDoctrineStore();
    const enforcer = new DoctrineEnforcer(store);

    assert.equal(
      (await enforcer.authorize(runtimeTransition("task", "running", "evaluating"))).result,
      "allow",
    );
    const forgedFrom = await enforcer.authorize(
      runtimeTransition("task", "pending", "running"),
    );
    assert.equal(forgedFrom.result, "deny");
    const withoutPass = await enforcer.authorize(
      runtimeTransition("task", "evaluating", "completed"),
    );
    assert.equal(withoutPass.result, "deny");
    assert.equal(
      withoutPass.result === "deny" && withoutPass.violation.code,
      "INVALID_STATE_TRANSITION",
    );
    const reportId = randomUUID();
    const task = store.tasks[0]!;
    store.tasks[0] = { ...task, status: "evaluating" };
    store.reports.push({
      id: reportId,
      missionId: MISSION_ID,
      taskId: TASK_ID,
      agentId: "worker-01",
      attempt: 1,
      output: { evidence: true },
      status: "success",
      summary: "Evidence collected",
      problems: [],
      risks: [],
      decisionRequired: false,
      createdAt: NOW,
    });
    store.events.push({
      id: randomUUID(),
      missionId: MISSION_ID,
      type: "EvaluationPassed",
      actor: "worker-01",
      payload: { taskId: TASK_ID, reportId },
      createdAt: NOW,
    });
    const forgedEvaluation = await enforcer.authorize(
      runtimeTransition("task", "evaluating", "completed", "pass", reportId),
    );
    assert.equal(forgedEvaluation.result, "deny");
    store.events.push({
      id: randomUUID(),
      missionId: MISSION_ID,
      type: "EvaluationPassed",
      actor: "evaluator-01",
      payload: { taskId: TASK_ID, reportId },
      createdAt: NOW,
    });
    assert.equal(
      (
        await enforcer.authorize(
          runtimeTransition("task", "evaluating", "completed", "pass", reportId),
        )
      ).result,
      "allow",
    );
    const invalid = await enforcer.authorize(
      runtimeTransition("mission", "completed", "executing"),
    );
    assert.equal(invalid.result, "deny");
    assert.equal(
      invalid.result === "deny" && invalid.violation.code,
      "INVALID_STATE_TRANSITION",
    );
  });

  it("rejects malformed DecisionRequest before audit", async () => {
    const store = new TestDoctrineStore();
    const enforcer = new DoctrineEnforcer(store);
    const initialEventCount = store.events.length;
    await assert.rejects(
      enforcer.authorize({
        actorId: "worker-01",
        role: "worker",
        missionId: MISSION_ID,
      } as DecisionRequest),
    );
    assert.equal(store.events.length, initialEventCount);
  });
});

describe("Explicit escalation", () => {
  it("persists a correctly routed request without mutating upper-level state", async () => {
    const store = new TestDoctrineStore();
    const enforcer = new DoctrineEnforcer(store);
    const result = await enforcer.escalate({
      id: randomUUID(),
      missionId: MISSION_ID,
      taskId: TASK_ID,
      requesterId: "worker-01",
      decisionType: "plan.modify",
      reason: "Task decomposition must change",
      requestedChange: { addTask: "repair" },
      targetRole: "lead",
      createdAt: NOW,
    });

    assert.equal(result.result, "escalate");
    assert.equal(store.escalations.length, 1);
    assert.equal(store.authorizations.at(-1)?.result, "escalate");
    for (const type of [
      "DecisionRequested",
      "EscalationCreated",
      "AuthorizationEscalated",
    ]) {
      assert.ok(store.events.some((event) => event.type === type));
    }
    assert.equal(store.events.some(({ type }) => type === "MissionReplanned"), false);
  });

  it("denies an escalation addressed to a non-owner", async () => {
    const store = new TestDoctrineStore();
    const result = await new DoctrineEnforcer(store).escalate({
      id: randomUUID(),
      missionId: MISSION_ID,
      requesterId: "worker-01",
      decisionType: "mission.scope.modify",
      reason: "Scope change required",
      targetRole: "lead",
      createdAt: NOW,
    });
    assert.equal(result.result, "deny");
    assert.equal(store.escalations.length, 0);
  });

  it("allows only an actor in the escalation target role to resolve it", async () => {
    const store = new TestDoctrineStore();
    const enforcer = new DoctrineEnforcer(store, { now: () => NOW });
    const opened = await enforcer.escalate({
      id: randomUUID(),
      missionId: MISSION_ID,
      taskId: TASK_ID,
      requesterId: "worker-01",
      decisionType: "plan.modify",
      reason: "Plan owner decision required",
      targetRole: "lead",
      createdAt: NOW,
    });
    assert.equal(opened.result, "escalate");
    if (opened.result !== "escalate") return;

    const wrongRole = await enforcer.resolveEscalation({
      id: randomUUID(),
      escalationId: opened.escalation.id,
      actorId: "worker-01",
      reason: "Self-approved",
      createdAt: NOW,
    });
    assert.equal(wrongRole.result, "deny");

    const resolved = await enforcer.resolveEscalation({
      id: randomUUID(),
      escalationId: opened.escalation.id,
      actorId: "lead-01",
      reason: "Plan change accepted",
      createdAt: NOW,
    });
    assert.equal(resolved.result, "allow");
    assert.equal(
      resolved.result === "allow" && resolved.escalation.status,
      "resolved",
    );
    assert.ok(store.events.some(({ type }) => type === "EscalationResolved"));
  });

  it("requires Mission permission when resolving a Mission escalation with a taskId", async () => {
    const store = new TestDoctrineStore();
    const enforcer = new DoctrineEnforcer(store, {
      now: () => NOW,
      roleAuthorities: [
        {
          subjectId: "commander-01",
          role: "commander",
          permissions: [
            {
              action: "mission.scope.modify",
              resource: { type: "task", taskId: TASK_ID },
            },
          ],
          constraints: [],
          riskLimits: [],
        },
      ],
    });
    const opened = await enforcer.escalate({
      id: randomUUID(),
      missionId: MISSION_ID,
      taskId: TASK_ID,
      requesterId: "worker-01",
      decisionType: "mission.scope.modify",
      reason: "Mission scope owner decision required",
      targetRole: "commander",
      createdAt: NOW,
    });
    assert.equal(opened.result, "escalate");
    if (opened.result !== "escalate") return;

    const resolved = await enforcer.resolveEscalation({
      id: randomUUID(),
      escalationId: opened.escalation.id,
      actorId: "commander-01",
      reason: "Attempted task-scoped approval",
      createdAt: NOW,
    });
    assert.equal(resolved.result, "deny");
  });

  it("enforces target constraints and authoritative Mission risk during resolution", async () => {
    const cases = [
      {
        configure(store: TestDoctrineStore) {
          return {
            store,
            constraints: [
              {
                id: "no-scope-resolution",
                sourceId: "human",
                kind: "prohibit" as const,
                target: "mission.scope.modify",
                scope: { type: "mission" as const, missionId: MISSION_ID },
                inherited: true,
              },
            ],
            riskLimits: [],
          };
        },
        code: "CONSTRAINT_VIOLATION",
      },
      {
        configure(store: TestDoctrineStore) {
          store.missions[0] = {
            ...store.missions[0]!,
            intent: { ...store.missions[0]!.intent, risk: { cost: 99 } },
          };
          return {
            store,
            constraints: [],
            riskLimits: [
              { dimension: "cost", operator: "lte" as const, value: 10 },
            ],
          };
        },
        code: "RISK_LIMIT_EXCEEDED",
      },
    ] as const;

    for (const testCase of cases) {
      const configured = testCase.configure(new TestDoctrineStore());
      const enforcer = new DoctrineEnforcer(configured.store, {
        now: () => NOW,
        roleAuthorities: [
          {
            subjectId: "commander-01",
            role: "commander",
            permissions: [
              {
                action: "mission.scope.modify",
                resource: { type: "mission", missionId: MISSION_ID },
              },
            ],
            constraints: [...configured.constraints],
            riskLimits: [...configured.riskLimits],
          },
        ],
      });
      const opened = await enforcer.escalate({
        id: randomUUID(),
        missionId: MISSION_ID,
        taskId: TASK_ID,
        requesterId: "worker-01",
        decisionType: "mission.scope.modify",
        reason: "Owner resolution required",
        targetRole: "commander",
        createdAt: NOW,
      });
      assert.equal(opened.result, "escalate");
      if (opened.result !== "escalate") continue;
      const resolved = await enforcer.resolveEscalation({
        id: randomUUID(),
        escalationId: opened.escalation.id,
        actorId: "commander-01",
        reason: "Attempted resolution",
        createdAt: NOW,
      });
      assert.equal(resolved.result, "deny");
      assert.equal(
        resolved.result === "deny" && resolved.violation.code,
        testCase.code,
      );
    }
  });
});
