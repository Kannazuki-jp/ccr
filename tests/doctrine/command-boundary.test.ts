import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import type {
  DecisionRequest,
  DecisionType,
  DoctrineActorRole,
} from "../../src/domain/index.js";
import {
  DoctrineEnforcer,
  getDecisionOwner,
  getDecisionRight,
} from "../../src/runtime/doctrine/index.js";
import * as PublicApi from "../../src/index.js";
import { MISSION_ID, TASK_ID, TestDoctrineStore } from "./test-store.js";

const NOW = new Date("2026-08-20T01:00:00.000Z");

function request(
  role: DoctrineActorRole,
  decisionType: DecisionType,
  overrides: Partial<DecisionRequest> = {},
): DecisionRequest {
  return {
    id: randomUUID(),
    actorId: role === "human" || role === "runtime" ? role : `${role}-01`,
    role,
    missionId: MISSION_ID,
    taskId: TASK_ID,
    decisionType,
    action: decisionType,
    createdAt: NOW,
    ...overrides,
  };
}

describe("Doctrine command boundary registry", () => {
  it("maps every representative decision to its deterministic owner", () => {
    assert.equal(getDecisionOwner("goal.modify"), "human");
    assert.equal(getDecisionOwner("mission.scope.modify"), "commander");
    assert.equal(getDecisionOwner("task.create"), "lead");
    assert.equal(getDecisionOwner("execution.method.select"), "worker");
    assert.equal(getDecisionOwner("evaluation.pass"), "evaluator");
    assert.equal(getDecisionOwner("state.transition"), "runtime");
    assert.equal(getDecisionOwner("mission.cancel"), "human");
    assert.equal(getDecisionRight("commander", "mission.cancel"), "delegated");
    assert.equal(getDecisionRight("evaluator", "evaluation.pass"), "verify");
    assert.equal(getDecisionRight("runtime", "state.transition"), "enforce");
  });

  it("does not publish internal authorization consume primitives", () => {
    assert.equal("consumeRuntimeTransitionAuthorization" in PublicApi, false);
    assert.equal("consumeTaskAssignmentAuthorization" in PublicApi, false);
    assert.equal("issueRuntimeTransitionPermit" in PublicApi, false);
    assert.equal("issueTaskAssignmentPermit" in PublicApi, false);
  });
});

describe("Doctrine command boundary enforcement", () => {
  it("allows the lowest competent owner to decide locally", async () => {
    const store = new TestDoctrineStore();
    const enforcer = new DoctrineEnforcer(store);
    store.grants.push({
      id: randomUUID(),
      issuerId: "lead-01",
      subjectId: "worker-01",
      missionId: MISSION_ID,
      taskId: TASK_ID,
      permissions: [
        { action: "execution.method.select", resource: { type: "task", taskId: TASK_ID } },
      ],
      constraints: [],
      riskLimits: [],
      status: "active",
      createdAt: NOW,
    });
    const cases: Array<[
      DoctrineActorRole,
      DecisionType,
      Partial<DecisionRequest>?,
    ]> = [
      ["human", "goal.modify"],
      ["commander", "mission.scope.modify"],
      ["lead", "task.create", { taskId: randomUUID() }],
      ["lead", "plan.modify"],
      [
        "worker",
        "execution.method.select",
        { resource: { type: "task", taskId: TASK_ID } },
      ],
      ["evaluator", "evaluation.pass"],
    ];

    for (const [role, decisionType, overrides] of cases) {
      assert.equal((await enforcer.authorize(request(role, decisionType, overrides))).result, "allow");
    }
    assert.equal(
      store.events.filter(({ type }) => type === "AuthorizationAllowed").length,
      cases.length,
    );
  });

  it("routes legitimate cross-boundary needs to the decision owner", async () => {
    const store = new TestDoctrineStore();
    const enforcer = new DoctrineEnforcer(store);

    const commanderGoal = await enforcer.authorize(
      request("commander", "goal.modify", { context: { intent: "request_change" } }),
    );
    const leadPurpose = await enforcer.authorize(
      request("lead", "mission.purpose.modify", { context: { intent: "request_change" } }),
    );
    const workerPlan = await enforcer.authorize(
      request("worker", "plan.modify", { context: { intent: "request_change" } }),
    );
    const workerScope = await enforcer.authorize(
      request("worker", "mission.scope.modify", { context: { intent: "request_change" } }),
    );

    assert.equal(commanderGoal.result, "escalate");
    assert.equal(commanderGoal.result === "escalate" && commanderGoal.escalation.targetRole, "human");
    assert.equal(leadPurpose.result === "escalate" && leadPurpose.escalation.targetRole, "commander");
    assert.equal(workerPlan.result === "escalate" && workerPlan.escalation.targetRole, "lead");
    assert.equal(workerScope.result === "escalate" && workerScope.escalation.targetRole, "commander");
    assert.equal(store.escalations.length, 4);
    assert.equal(
      store.events.filter(({ type }) => type === "AuthorizationEscalated").length,
      4,
    );
  });

  it("uses one stable timestamp for an authorization row and its audit event", async () => {
    const store = new TestDoctrineStore();
    let milliseconds = NOW.getTime();
    const enforcer = new DoctrineEnforcer(store, {
      now: () => new Date(milliseconds++),
    });
    const result = await enforcer.authorize(
      request("worker", "mission.scope.modify", { context: { intent: "request_change" } }),
    );
    assert.equal(result.result, "escalate");

    const record = store.authorizations.at(-1);
    const event = store.events.find(
      ({ type, payload }) =>
        type === "AuthorizationEscalated" &&
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload) &&
        payload.requestId === record?.requestId,
    );
    assert.equal(event?.createdAt.getTime(), record?.createdAt.getTime());
  });

  it("denies direct doctrine violations and actor role spoofing", async () => {
    const store = new TestDoctrineStore();
    store.grants.push({
      id: randomUUID(),
      issuerId: "lead-01",
      subjectId: "worker-01",
      missionId: MISSION_ID,
      taskId: TASK_ID,
      permissions: [
        { action: "tool.select", resource: { type: "tool", tool: "node:test" } },
      ],
      constraints: [],
      riskLimits: [],
      status: "active",
      createdAt: NOW,
    });
    const enforcer = new DoctrineEnforcer(store);

    const workerGoal = await enforcer.authorize(request("worker", "goal.modify"));
    const workerMission = await enforcer.authorize(
      request("worker", "mission.create"),
    );
    const spoof = await enforcer.authorize(
      request("commander", "mission.scope.modify", { actorId: "worker-01" }),
    );

    for (const result of [workerGoal, workerMission, spoof]) {
      assert.equal(result.result, "deny");
      assert.equal(
        result.result === "deny" && result.violation.code,
        "COMMAND_BOUNDARY_VIOLATION",
      );
    }
    assert.equal(store.violations.length, 3);
    assert.equal(
      store.events.filter(({ type }) => type === "AuthorizationDenied").length,
      3,
    );
  });

  it("allows a scoped tool selection without central approval when delegated", async () => {
    const store = new TestDoctrineStore();
    store.grants.push({
      id: randomUUID(),
      issuerId: "lead-01",
      subjectId: "worker-01",
      missionId: MISSION_ID,
      taskId: TASK_ID,
      permissions: [
        { action: "tool.select", resource: { type: "tool", tool: "node:test" } },
      ],
      constraints: [],
      riskLimits: [],
      status: "active",
      createdAt: NOW,
    });
    const enforcer = new DoctrineEnforcer(store);
    const result = await enforcer.authorize(
      request("worker", "execution.tool.select", {
        action: "tool.select",
        resource: { type: "tool", tool: "node:test" },
      }),
    );

    assert.equal(result.result, "allow");
    assert.equal(store.escalations.length, 0);
  });

  it("allows an explicitly delegated transferable decision but routes it without a grant", async () => {
    const withoutGrantStore = new TestDoctrineStore();
    const withoutGrant = await new DoctrineEnforcer(withoutGrantStore).authorize(
      request("lead", "execution.tool.select", {
        action: "tool.select",
        resource: { type: "tool", tool: "node:test" },
      }),
    );
    assert.equal(withoutGrant.result, "deny");

    const delegatedStore = new TestDoctrineStore();
    delegatedStore.grants.push({
      id: randomUUID(),
      issuerId: "commander-01",
      subjectId: "lead-01",
      missionId: MISSION_ID,
      permissions: [
        { action: "tool.select", resource: { type: "tool", tool: "node:test" } },
      ],
      constraints: [],
      riskLimits: [],
      status: "active",
      createdAt: NOW,
    });
    const delegated = await new DoctrineEnforcer(delegatedStore).authorize(
      request("lead", "execution.tool.select", {
        action: "tool.select",
        resource: { type: "tool", tool: "node:test" },
      }),
    );
    assert.equal(delegated.result, "allow");
  });

  it("supports the normative v0.2 aliases without skipping scoped authority", async () => {
    const store = new TestDoctrineStore();
    store.grants.push({
      id: randomUUID(),
      issuerId: "lead-01",
      subjectId: "worker-01",
      missionId: MISSION_ID,
      taskId: TASK_ID,
      permissions: [
        {
          action: "execution.method.select",
          resource: { type: "task", taskId: TASK_ID },
        },
      ],
      constraints: [],
      riskLimits: [],
      status: "active",
      createdAt: NOW,
    });
    const enforcer = new DoctrineEnforcer(store);

    const scopeChange = await enforcer.authorize({
      id: randomUUID(),
      actorId: "worker-01",
      role: "worker",
      missionId: MISSION_ID,
      decisionType: "mission.scope.modify",
      action: "modify",
      createdAt: NOW,
    });
    const methodSelection = await enforcer.authorize({
      id: randomUUID(),
      actorId: "worker-01",
      role: "worker",
      missionId: MISSION_ID,
      taskId: TASK_ID,
      decisionType: "execution.method.select",
      action: "select",
      createdAt: NOW,
    });

    assert.equal(scopeChange.result, "escalate");
    assert.equal(
      scopeChange.result === "escalate" && scopeChange.escalation.targetRole,
      "commander",
    );
    assert.equal(methodSelection.result, "allow");
  });

  it("fails closed for unknown and decision/action-mismatched requests", async () => {
    const store = new TestDoctrineStore();
    store.grants.push({
      id: randomUUID(),
      issuerId: "lead-01",
      subjectId: "worker-01",
      missionId: MISSION_ID,
      taskId: TASK_ID,
      permissions: [
        { action: "code.edit", resource: { type: "path", pattern: "src/**" } },
      ],
      constraints: [],
      riskLimits: [],
      status: "active",
      createdAt: NOW,
    });
    const enforcer = new DoctrineEnforcer(store);
    const unknown = await enforcer.authorize(
      request("worker", "execution.local_change", {
        action: "shell.root",
        resource: { type: "path", pattern: "src/index.ts" },
      }),
    );
    const disguised = await enforcer.authorize(
      request("worker", "execution.method.select", {
        action: "code.edit",
        resource: { type: "path", pattern: "src/index.ts" },
      }),
    );

    for (const result of [unknown, disguised]) {
      assert.equal(result.result, "deny");
      assert.equal(
        result.result === "deny" && result.violation.code,
        "COMMAND_BOUNDARY_VIOLATION",
      );
    }
  });

  it("validates stored mission, task, assignment, and cross-mission consistency", async () => {
    const store = new TestDoctrineStore();
    const secondMissionId = randomUUID();
    const secondTaskId = randomUUID();
    store.missions.push({
      ...store.missions[0]!,
      id: secondMissionId,
    });
    store.tasks.push({
      ...store.tasks[0]!,
      id: secondTaskId,
      missionId: secondMissionId,
      assignedAgentId: undefined,
    });
    for (const role of ["commander", "lead"] as const) {
      store.agents.push({
        ...store.agents.find((agent) => agent.role === role)!,
        id: `${role}-02`,
      });
    }
    const enforcer = new DoctrineEnforcer(store);

    const fakeMission = await enforcer.authorize(
      request("lead", "plan.modify", { missionId: randomUUID(), taskId: undefined }),
    );
    const fakeTask = await enforcer.authorize(
      request("worker", "execution.method.select", { taskId: randomUUID() }),
    );
    const wrongMission = await enforcer.authorize(
      request("worker", "execution.method.select", {
        missionId: MISSION_ID,
        taskId: secondTaskId,
      }),
    );
    const unassigned = await enforcer.authorize(
      request("worker", "execution.method.select", {
        missionId: secondMissionId,
        taskId: secondTaskId,
      }),
    );
    const unboundCommander = await enforcer.authorize(
      request("commander", "mission.scope.modify", {
        actorId: "commander-02",
        taskId: undefined,
      }),
    );
    const unboundLead = await enforcer.authorize(
      request("lead", "plan.modify", {
        actorId: "lead-02",
        taskId: undefined,
      }),
    );

    for (const result of [
      fakeMission,
      fakeTask,
      wrongMission,
      unassigned,
      unboundCommander,
      unboundLead,
    ]) {
      assert.equal(result.result, "deny");
    }
  });

  it("enforces configured constraints and risk limits before Mission persistence", async () => {
    const missionId = randomUUID();
    const store = new TestDoctrineStore();
    const enforcer = new DoctrineEnforcer(store, {
      roleAuthorities: [
        {
          subjectId: "commander-01",
          role: "commander",
          permissions: [{ action: "mission.*", resource: { type: "global" } }],
          constraints: [
            {
              id: "no-create",
              sourceId: "human",
              kind: "prohibit",
              target: "mission.create",
              inherited: true,
            },
          ],
          riskLimits: [],
        },
      ],
    });
    const result = await enforcer.authorize(
      request("commander", "mission.create", {
        missionId,
        taskId: undefined,
        action: "create",
      }),
    );

    assert.equal(result.result, "deny");
    assert.equal(
      result.result === "deny" && result.violation.code,
      "CONSTRAINT_VIOLATION",
    );

    const riskStore = new TestDoctrineStore();
    const riskResult = await new DoctrineEnforcer(riskStore, {
      roleAuthorities: [
        {
          subjectId: "commander-01",
          role: "commander",
          permissions: [{ action: "mission.*", resource: { type: "global" } }],
          constraints: [],
          riskLimits: [{ dimension: "cost", operator: "lte", value: 10 }],
        },
      ],
    }).authorize(
      request("commander", "mission.create", {
        missionId: randomUUID(),
        taskId: undefined,
        action: "create",
      }),
    );
    assert.equal(riskResult.result, "deny");
    assert.equal(
      riskResult.result === "deny" && riskResult.violation.code,
      "RISK_LIMIT_EXCEEDED",
    );

    const boundedCreate = await new DoctrineEnforcer(new TestDoctrineStore(), {
      roleAuthorities: [
        {
          subjectId: "commander-01",
          role: "commander",
          permissions: [
            { action: "mission.create", resource: { type: "global" } },
          ],
          constraints: [],
          riskLimits: [{ dimension: "cost", operator: "lte", value: 10 }],
        },
      ],
    }).authorize(
      request("commander", "mission.create", {
        missionId: randomUUID(),
        taskId: undefined,
        action: "create",
        context: { risk: { cost: 5 } },
      }),
    );
    assert.equal(boundedCreate.result, "allow");
  });

  it("requires permissions even for owner, verifier, and lifecycle decisions", async () => {
    const commanderStore = new TestDoctrineStore();
    const commander = await new DoctrineEnforcer(commanderStore, {
      roleAuthorities: [
        {
          subjectId: "commander-01",
          role: "commander",
          permissions: [],
          constraints: [],
          riskLimits: [],
        },
      ],
    }).authorize(
      request("commander", "mission.scope.modify", { taskId: undefined }),
    );
    assert.equal(commander.result, "deny");

    const leadStore = new TestDoctrineStore();
    const leadGrantId = randomUUID();
    leadStore.grants.push({
      id: leadGrantId,
      issuerId: "commander-01",
      subjectId: "lead-01",
      missionId: MISSION_ID,
      permissions: [
        { action: "plan.modify", resource: { type: "global" } },
      ],
      constraints: [],
      riskLimits: [],
      status: "active",
      createdAt: NOW,
    });
    const leadEnforcer = new DoctrineEnforcer(leadStore);
    assert.equal(
      (
        await leadEnforcer.revoke({
          actorId: "commander-01",
          grantId: leadGrantId,
          reason: "Lead authority withdrawn",
        })
      ).result,
      "allow",
    );
    const lead = await leadEnforcer.authorize(
      request("lead", "plan.modify", { taskId: undefined }),
    );
    assert.equal(lead.result, "deny");

    const evaluatorStore = new TestDoctrineStore();
    const evaluator = await new DoctrineEnforcer(evaluatorStore, {
      roleAuthorities: [
        {
          subjectId: "evaluator-01",
          role: "evaluator",
          permissions: [],
          constraints: [],
          riskLimits: [],
        },
      ],
    }).authorize(request("evaluator", "evaluation.pass"));
    assert.equal(evaluator.result, "deny");
  });

  it("does not escalate a taskless Worker without a Mission binding", async () => {
    const store = new TestDoctrineStore();
    store.agents.push({
      ...store.agents.find(({ role }) => role === "worker")!,
      id: "worker-02",
    });
    const result = await new DoctrineEnforcer(store).authorize(
      request("worker", "mission.scope.modify", {
        actorId: "worker-02",
        taskId: undefined,
        action: "modify",
      }),
    );

    assert.equal(result.result, "deny");
    assert.equal(store.escalations.length, 0);
  });

  it("does not downgrade Mission-wide decisions to a Task permission scope", async () => {
    const store = new TestDoctrineStore();
    const enforcer = new DoctrineEnforcer(store, {
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

    const inferred = await enforcer.authorize(
      request("commander", "mission.scope.modify", {
        action: "modify",
      }),
    );
    const explicit = await enforcer.authorize(
      request("commander", "mission.scope.modify", {
        action: "modify",
        resource: { type: "task", taskId: TASK_ID },
      }),
    );

    assert.equal(inferred.result, "deny");
    assert.equal(explicit.result, "deny");
  });
});
