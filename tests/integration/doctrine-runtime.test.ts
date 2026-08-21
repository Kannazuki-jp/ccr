import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import {
  DEFAULT_MISSION_PROPOSAL,
  createMockAgents,
  type MockScenario,
} from "../../src/agents/mock-agents.js";
import type {
  DecisionRequest,
  DoctrineActorRole,
  Permission,
  RoleAuthority,
  TaskPlan,
} from "../../src/domain/index.js";
import {
  CommandControlRuntime,
  RuntimeAuthorizationError,
} from "../../src/runtime/runtime.js";
import { SqliteStore } from "../../src/storage/sqlite/index.js";

const ONE_TASK_PLAN: TaskPlan = [
  {
    key: "implement",
    objective: "Implement the bounded change",
    successCriteria: ["Evidence demonstrates the bounded change"],
    constraints: ["Remain within the delegated Task"],
    authority: {
      allowed: [
        "execution.method.select",
        "execution.tool.select",
        "execution.local_change",
        "code.edit",
        "test.run",
        "report.submit",
        "execution.retry",
      ],
      prohibited: ["production.delete"],
      requiresApproval: [],
    },
    dependencies: [],
  },
];

async function completedFixture(options: {
  readonly scenario?: MockScenario;
} = {}) {
  const store = new SqliteStore();
  const agents = createMockAgents({
    scenario: options.scenario ?? "happy",
    lead: { plan: ONE_TASK_PLAN },
  });
  const runtime = new CommandControlRuntime(store, agents);
  const result = await runtime.run({ goal: "Exercise Doctrine enforcement" });
  return { store, runtime, result };
}

function request(
  fixture: Awaited<ReturnType<typeof completedFixture>>,
  role: DecisionRequest["role"],
  actorId: string,
  decisionType: DecisionRequest["decisionType"],
  extras: Partial<DecisionRequest> = {},
): DecisionRequest {
  return {
    id: randomUUID(),
    actorId,
    role,
    missionId: fixture.result.mission.id,
    decisionType,
    action: decisionType,
    createdAt: new Date(),
    ...extras,
  };
}

function globalPermission(action: string): Permission {
  return { action, resource: { type: "global" } };
}

function roleAuthority(
  subjectId: string,
  role: DoctrineActorRole,
  actions: readonly string[],
): RoleAuthority {
  return {
    subjectId,
    role,
    permissions: actions.map(globalPermission),
    constraints: [],
    riskLimits: [],
  };
}

function runtimeAgentRoleAuthorities(
  commanderRiskLimits: RoleAuthority["riskLimits"] = [],
): RoleAuthority[] {
  return [
    {
      ...roleAuthority("mock-commander", "commander", [
        "mission.*",
        "task.*",
        "plan.modify",
        "authority.delegate",
        "execution.*",
        "report.submit",
        "code.*",
        "public_api.modify",
        "test.run",
        "tool.select",
      ]),
      riskLimits: [...commanderRiskLimits],
    },
    roleAuthority("mock-lead", "lead", [
      "task.*",
      "plan.modify",
      "authority.delegate",
      "execution.*",
      "report.submit",
      "code.*",
      "public_api.modify",
      "test.run",
      "tool.select",
    ]),
    roleAuthority("mock-worker", "worker", [
      "execution.*",
      "report.submit",
      "code.*",
      "public_api.modify",
      "test.run",
      "tool.select",
    ]),
    roleAuthority("mock-evaluator", "evaluator", ["evaluation.*"]),
  ];
}

function assertEscalationAudit(
  store: SqliteStore,
  missionId: string,
  requestId: string,
  escalationId: string,
): void {
  const relevant = store.listEvents(missionId).filter(({ payload }) => {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return false;
    }
    return payload.requestId === requestId || payload.escalationId === escalationId;
  });
  assert.deepEqual(
    relevant.map(({ type }) => type),
    ["DecisionRequested", "EscalationCreated", "AuthorizationEscalated"],
  );
  assert.ok(
    store.listAuthorizationRecords(missionId).some(
      ({ requestId: candidate, result }) =>
        candidate === requestId && result === "escalate",
    ),
  );
  assert.equal(
    store.listEscalations(missionId).find(({ id }) => id === escalationId)?.status,
    "open",
  );
}

describe("Doctrine Runtime integration scenarios", () => {
  it("Scenario A: bounded Worker autonomy completes without escalation", async () => {
    const fixture = await completedFixture({ scenario: "retry" });
    try {
      const { result, store } = fixture;
      assert.equal(result.status, "completed");
      assert.equal(result.reports.length, 2);
      assert.equal(result.tasks[0]?.status, "completed");
      assert.equal(result.tasks[0]?.attempts, 2);
      assert.equal(store.listEscalations(result.mission.id).length, 0);
      assert.equal(store.listDoctrineViolations(result.mission.id).length, 0);
      assert.equal(
        store
          .listAuthorityGrants(result.mission.id, "mock-worker")
          .filter(({ status }) => status === "active").length,
        1,
      );

      const authorizations = store.listAuthorizationRecords(result.mission.id);
      assert.ok(authorizations.length > 0);
      assert.ok(authorizations.every(({ result: value }) => value === "allow"));
      for (const decisionType of [
        "goal.create",
        "mission.create",
        "plan.modify",
        "task.create",
        "authority.delegate",
        "task.assign",
        "execution.method.select",
        "execution.tool.select",
        "execution.local_change",
        "execution.retry",
        "report.submit",
        "evaluation.verify",
        "evaluation.pass",
        "state.transition",
      ] as const) {
        assert.ok(
          authorizations.some(
            (authorization) => authorization.decisionType === decisionType,
          ),
          `missing ${decisionType} authorization`,
        );
      }

      const types = result.events.map(({ type }) => type);
      assert.ok(types.includes("TaskRetryScheduled"));
      assert.ok(types.indexOf("ReportSubmitted") < types.indexOf("EvaluationPassed"));
      assert.ok(types.indexOf("EvaluationPassed") < types.indexOf("TaskCompleted"));
      assert.equal(result.events.at(-1)?.type, "MissionCompleted");
    } finally {
      fixture.store.close();
    }
  });

  it("TaskPlan authority and Mission constraints/risk become enforced Doctrine grants", async () => {
    const store = new SqliteStore();
    const plan = structuredClone(ONE_TASK_PLAN);
    plan[0]!.authority.allowed = plan[0]!.authority.allowed.filter(
      (action) =>
        action !== "execution.tool.select" &&
        action !== "execution.local_change" &&
        action !== "code.edit",
    );
    plan[0]!.authority.prohibited = ["public_api.modify"];
    plan[0]!.authority.requiresApproval = ["tool.select"];
    const agents = createMockAgents({
      commander: {
        proposal: {
          ...structuredClone(DEFAULT_MISSION_PROPOSAL),
          intent: {
            ...structuredClone(DEFAULT_MISSION_PROPOSAL.intent),
            constraints: ["prohibit:production.delete"],
            riskLimits: [{ dimension: "cost", operator: "lte", value: 10 }],
            risk: { cost: 5 },
          },
        },
      },
      lead: { plan },
    });
    const runtime = new CommandControlRuntime(store, agents);
    try {
      const result = await runtime.run({ goal: "Enforce planned Doctrine" });
      assert.equal(result.status, "completed");
      const taskId = result.tasks[0]!.id;
      assert.deepEqual(result.tasks[0]!.risk, { cost: 5 });
      const grant = store.listAuthorityGrants(
        result.mission.id,
        "mock-worker",
      ).find(({ taskId: candidate }) => candidate === taskId);
      assert.ok(grant !== undefined);
      assert.deepEqual(
        new Set(grant.permissions.map(({ action }) => action)),
        new Set([
          ...plan[0]!.authority.allowed,
          ...plan[0]!.authority.requiresApproval,
        ]),
      );
      assert.ok(grant.constraints.some(
        ({ kind, target }) => kind === "prohibit" && target === "production.delete",
      ));
      assert.ok(grant.constraints.some(
        ({ kind, target, value }) =>
          kind === "require" && target === "runtime.approval" && value === "tool.select",
      ));
      assert.deepEqual(grant.riskLimits, [
        { dimension: "cost", operator: "lte", value: 10 },
      ]);
      const effective = await runtime.resolveEffectiveAuthority("mock-worker", {
        missionId: result.mission.id,
        taskId,
        role: "worker",
      });
      assert.deepEqual(effective.riskLimits, grant.riskLimits);

      const prohibited = await runtime.authorizeDecision(
        request({ store, runtime, result }, "worker", "mock-worker", "execution.local_change", {
          taskId,
          action: "public_api.modify",
          resource: { type: "task", taskId },
          context: { risk: { cost: 5 } },
        }),
      );
      assert.equal(prohibited.result, "deny");
      if (prohibited.result === "deny") {
        assert.equal(prohibited.violation.code, "INSUFFICIENT_AUTHORITY");
      }

      const approvalRequired = await runtime.authorizeDecision(
        request({ store, runtime, result }, "worker", "mock-worker", "execution.tool.select", {
          taskId,
          action: "tool.select",
          resource: { type: "task", taskId },
          context: { risk: { cost: 5 } },
        }),
      );
      assert.equal(approvalRequired.result, "deny");
      if (approvalRequired.result === "deny") {
        assert.equal(approvalRequired.violation.code, "CONSTRAINT_VIOLATION");
      }

      const spoofedRisk = await runtime.authorizeDecision(
        request({ store, runtime, result }, "worker", "mock-worker", "execution.procedure.modify", {
          taskId,
          action: "test.run",
          resource: { type: "task", taskId },
          context: { risk: { cost: 11 } },
        }),
      );
      assert.equal(spoofedRisk.result, "allow");
    } finally {
      store.close();
    }
  });

  it("requiresApproval fails closed before an active Worker action executes", async () => {
    const store = new SqliteStore();
    const plan = structuredClone(ONE_TASK_PLAN);
    plan[0]!.authority.requiresApproval = ["tool.select"];
    const agents = createMockAgents({ lead: { plan } });
    try {
      await assert.rejects(
        new CommandControlRuntime(store, agents).run({
          goal: "Reject an unapproved active Worker action",
        }),
        (error: unknown) =>
          error instanceof RuntimeAuthorizationError &&
          error.authorization.result === "deny" &&
          error.authorization.violation.code === "CONSTRAINT_VIOLATION",
      );
      assert.equal(agents.worker.callCount, 0);
      assert.equal(store.listReports().length, 0);
      assert.equal(store.listMissions()[0]?.status, "executing");
      assert.equal(store.listTasks()[0]?.status, "running");
      assert.ok(
        store.listAuthorizationRecords().some(
          ({ decisionType, result }) =>
            decisionType === "execution.tool.select" && result === "deny",
        ),
      );
    } finally {
      store.close();
    }
  });

  it("authoritative Task risk above a Mission limit denies before Task persistence", async () => {
    const store = new SqliteStore();
    const plan = structuredClone(ONE_TASK_PLAN);
    plan[0]!.risk = { cost: 99 };
    const agents = createMockAgents({
      commander: {
        proposal: {
          ...structuredClone(DEFAULT_MISSION_PROPOSAL),
          intent: {
            ...structuredClone(DEFAULT_MISSION_PROPOSAL.intent),
            riskLimits: [{ dimension: "cost", operator: "lte", value: 10 }],
            risk: { cost: 1 },
          },
        },
      },
      lead: { plan },
    });
    try {
      await assert.rejects(
        new CommandControlRuntime(store, agents).run({
          goal: "Reject excessive authoritative risk",
        }),
        (error: unknown) =>
          error instanceof RuntimeAuthorizationError &&
          error.authorization.result === "deny" &&
          error.authorization.violation.code === "RISK_LIMIT_EXCEEDED",
      );
      assert.equal(agents.worker.callCount, 0);
      assert.equal(store.listReports().length, 0);
      assert.equal(store.listTasks().length, 0);
      assert.equal(store.listMissions()[0]?.status, "planning");
      assert.ok(
        store.listAuthorizationRecords().some(
          ({ decisionType, result }) =>
            decisionType === "task.create" && result === "deny",
        ),
      );
    } finally {
      store.close();
    }
  });

  it("custom Role Authorities cannot disable protected Human and Runtime enforcement", async () => {
    const store = new SqliteStore();
    const agents = createMockAgents({ lead: { plan: ONE_TASK_PLAN } });
    const roleAuthorities: RoleAuthority[] = [
      ...runtimeAgentRoleAuthorities(),
      {
        subjectId: "human",
        role: "human",
        permissions: [],
        constraints: [{
          id: "external-human-disable",
          sourceId: "external",
          kind: "prohibit",
          target: "goal.create",
          inherited: true,
        }],
        riskLimits: [],
      },
      {
        subjectId: "runtime",
        role: "runtime",
        permissions: [],
        constraints: [{
          id: "external-runtime-disable",
          sourceId: "external",
          kind: "prohibit",
          target: "state.transition",
          inherited: true,
        }],
        riskLimits: [],
      },
    ];
    const runtime = new CommandControlRuntime(store, agents, {
      doctrine: { roleAuthorities },
    });
    try {
      const result = await runtime.run({
        goal: "Preserve protected enforcement authorities",
      });
      assert.equal(result.status, "completed");
      const records = store.listAuthorizationRecords(result.mission.id);
      assert.ok(
        records.some(
          ({ actorId, decisionType, result: value }) =>
            actorId === "human" &&
            decisionType === "goal.create" &&
            value === "allow",
        ),
      );
      assert.ok(
        records.some(
          ({ actorId, decisionType, result: value }) =>
            actorId === "runtime" &&
            decisionType === "state.transition" &&
            value === "allow",
        ),
      );
    } finally {
      store.close();
    }
  });

  it("mission.create uses the parsed Commander proposal risk for Role Authority limits", async () => {
    const store = new SqliteStore();
    const proposal = structuredClone(DEFAULT_MISSION_PROPOSAL);
    proposal.intent.risk = { cost: 5 };
    const agents = createMockAgents({
      commander: { proposal },
      lead: { plan: ONE_TASK_PLAN },
    });
    const runtime = new CommandControlRuntime(store, agents, {
      doctrine: {
        roleAuthorities: runtimeAgentRoleAuthorities([
          { dimension: "cost", operator: "lte", value: 10 },
        ]),
      },
    });
    try {
      const result = await runtime.run({ goal: "Authorize measured Mission risk" });
      assert.equal(result.status, "completed");
      assert.deepEqual(result.mission.intent.risk, { cost: 5 });
      assert.ok(
        store.listAuthorizationRecords(result.mission.id).some(
          ({ decisionType, result: value }) =>
            decisionType === "mission.create" && value === "allow",
        ),
      );
    } finally {
      store.close();
    }
  });

  it("mission.create denies a missing Commander proposal risk required by Role Authority", async () => {
    const store = new SqliteStore();
    const agents = createMockAgents({ lead: { plan: ONE_TASK_PLAN } });
    const runtime = new CommandControlRuntime(store, agents, {
      doctrine: {
        roleAuthorities: runtimeAgentRoleAuthorities([
          { dimension: "cost", operator: "lte", value: 10 },
        ]),
      },
    });
    try {
      await assert.rejects(
        runtime.run({ goal: "Reject missing Mission risk" }),
        (error: unknown) =>
          error instanceof RuntimeAuthorizationError &&
          error.authorization.result === "deny" &&
          error.authorization.violation.code === "RISK_LIMIT_EXCEEDED",
      );
      assert.equal(agents.commander.callCount, 1);
      assert.equal(store.listMissions().length, 0);
      assert.ok(
        store.listAuthorizationRecords().some(
          ({ decisionType, result }) =>
            decisionType === "mission.create" && result === "deny",
        ),
      );
    } finally {
      store.close();
    }
  });

  it("Scenario B: a Worker task-plan request escalates to the Lead without mutation", async () => {
    const fixture = await completedFixture();
    try {
      const before = fixture.runtime.observeMission(fixture.result.mission.id);
      const direct = await fixture.runtime.authorizeDecision(
        request(fixture, "worker", "mock-worker", "plan.modify", {
          taskId: fixture.result.tasks[0]?.id,
          context: { requestedChange: { operation: "replace-task-plan" } },
        }),
      );
      assert.equal(direct.result, "deny");
      const requestId = randomUUID();
      const authorization = await fixture.runtime.escalateDecision({
        id: requestId,
        missionId: fixture.result.mission.id,
        taskId: fixture.result.tasks[0]?.id,
        requesterId: "mock-worker",
        decisionType: "plan.modify",
        reason: "Task decomposition must change",
        requestedChange: { operation: "replace-task-plan" },
        targetRole: "lead",
        createdAt: new Date(),
      });
      assert.equal(authorization.result, "escalate");
      if (authorization.result !== "escalate") return;
      assert.equal(authorization.escalation.targetRole, "lead");
      assertEscalationAudit(
        fixture.store,
        fixture.result.mission.id,
        requestId,
        authorization.escalation.id,
      );
      const wrongOwner = await fixture.runtime.resolveEscalation({
        id: randomUUID(),
        escalationId: authorization.escalation.id,
        actorId: "mock-commander",
        reason: "Commander must not resolve a Lead-owned escalation",
        createdAt: new Date(),
      });
      assert.equal(wrongOwner.result, "deny");
      assert.equal(
        fixture.store.getEscalation(authorization.escalation.id)?.status,
        "open",
      );
      const resolved = await fixture.runtime.resolveEscalation({
        id: randomUUID(),
        escalationId: authorization.escalation.id,
        actorId: "mock-lead",
        reason: "Lead accepted the bounded plan decision",
        createdAt: new Date(),
      });
      assert.equal(resolved.result, "allow");
      assert.equal(
        fixture.store.getEscalation(authorization.escalation.id)?.status,
        "resolved",
      );
      assert.ok(
        fixture.store.listEvents(fixture.result.mission.id)
          .some(({ type, payload }) =>
            type === "EscalationResolved" &&
            typeof payload === "object" && payload !== null &&
            !Array.isArray(payload) &&
            payload.escalationId === authorization.escalation.id),
      );
      const after = fixture.runtime.observeMission(fixture.result.mission.id);
      assert.equal(after?.mission.status, before?.mission.status);
      assert.deepEqual(after?.tasks, before?.tasks);
    } finally {
      fixture.store.close();
    }
  });

  it("Scenario B-D escalation requests leave active execution state unchanged", async () => {
    const store = new SqliteStore();
    let runtime!: CommandControlRuntime;
    const observed: Array<{
      beforeMission: string | undefined;
      afterMission: string | undefined;
      beforeTask: string | undefined;
      afterTask: string | undefined;
    }> = [];
    const agents = createMockAgents({
      lead: { plan: ONE_TASK_PLAN },
      worker: {
        onExecute: async (task) => {
          for (const escalation of [
            {
              requesterId: "mock-worker",
              decisionType: "plan.modify" as const,
              targetRole: "lead" as const,
            },
            {
              requesterId: "mock-worker",
              decisionType: "mission.scope.modify" as const,
              targetRole: "commander" as const,
            },
            {
              requesterId: "mock-lead",
              decisionType: "goal.modify" as const,
              targetRole: "human" as const,
            },
          ]) {
            const beforeMission = store.getMission(task.missionId)?.status;
            const beforeTask = store.getTask(task.id)?.status;
            const routed = await runtime.escalateDecision({
              id: randomUUID(),
              missionId: task.missionId,
              taskId: task.id,
              requesterId: escalation.requesterId,
              decisionType: escalation.decisionType,
              reason: `Active ${escalation.decisionType} decision required`,
              targetRole: escalation.targetRole,
              createdAt: new Date(),
            });
            assert.equal(routed.result, "escalate");
            observed.push({
              beforeMission,
              afterMission: store.getMission(task.missionId)?.status,
              beforeTask,
              afterTask: store.getTask(task.id)?.status,
            });
          }
          return {
            output: { outcome: "bounded execution continued" },
            report: {
              status: "success",
              summary: "Completed without applying upper-boundary changes",
              problems: [],
              risks: [],
              decisionRequired: false,
            },
          };
        },
      },
    });
    runtime = new CommandControlRuntime(store, agents);
    try {
      const result = await runtime.run({ goal: "Audit active escalation boundaries" });
      assert.equal(result.status, "completed");
      assert.deepEqual(observed, [
        {
          beforeMission: "executing",
          afterMission: "executing",
          beforeTask: "running",
          afterTask: "running",
        },
        {
          beforeMission: "executing",
          afterMission: "executing",
          beforeTask: "running",
          afterTask: "running",
        },
        {
          beforeMission: "executing",
          afterMission: "executing",
          beforeTask: "running",
          afterTask: "running",
        },
      ]);
    } finally {
      store.close();
    }
  });

  it("Scenario C: a Worker mission-scope request reaches the Commander without mutation", async () => {
    const fixture = await completedFixture();
    try {
      const before = structuredClone(fixture.result.mission);
      const requestId = randomUUID();
      const authorization = await fixture.runtime.escalateDecision({
        id: requestId,
        missionId: fixture.result.mission.id,
        taskId: fixture.result.tasks[0]?.id,
        requesterId: "mock-worker",
        decisionType: "mission.scope.modify",
        reason: "Mission scope must expand",
        requestedChange: { scope: "broader" },
        targetRole: "commander",
        createdAt: new Date(),
      });

      assert.equal(authorization.result, "escalate");
      if (authorization.result === "escalate") {
        assert.equal(authorization.escalation.targetRole, "commander");
        assertEscalationAudit(
          fixture.store,
          fixture.result.mission.id,
          requestId,
          authorization.escalation.id,
        );
      }
      assert.deepEqual(
        fixture.runtime.observeMission(fixture.result.mission.id)?.mission,
        before,
      );
    } finally {
      fixture.store.close();
    }
  });

  it("Scenario D: a Commander goal-change request escalates to the Human without mutation", async () => {
    const fixture = await completedFixture();
    try {
      const before = structuredClone(fixture.result.mission);
      const requestId = randomUUID();
      const authorization = await fixture.runtime.escalateDecision({
        id: requestId,
        missionId: fixture.result.mission.id,
        requesterId: "mock-commander",
        decisionType: "goal.modify",
        reason: "Goal itself is inconsistent",
        requestedChange: { goal: "replacement goal" },
        targetRole: "human",
        createdAt: new Date(),
      });

      assert.equal(authorization.result, "escalate");
      if (authorization.result === "escalate") {
        assert.equal(authorization.escalation.targetRole, "human");
        assertEscalationAudit(
          fixture.store,
          fixture.result.mission.id,
          requestId,
          authorization.escalation.id,
        );
      }
      const leadRequestId = randomUUID();
      const leadEscalation = await fixture.runtime.escalateDecision({
        id: leadRequestId,
        missionId: fixture.result.mission.id,
        requesterId: "mock-lead",
        decisionType: "goal.modify",
        reason: "Lead also identifies a Goal-level issue",
        targetRole: "human",
        createdAt: new Date(),
      });
      assert.equal(leadEscalation.result, "escalate");
      if (leadEscalation.result === "escalate") {
        assertEscalationAudit(
          fixture.store,
          fixture.result.mission.id,
          leadRequestId,
          leadEscalation.escalation.id,
        );
      }
      assert.deepEqual(
        fixture.runtime.observeMission(fixture.result.mission.id)?.mission,
        before,
      );
    } finally {
      fixture.store.close();
    }
  });

  it("Scenario E: authority exceeding the Lead effective authority is denied", async () => {
    const fixture = await completedFixture();
    try {
      const result = await fixture.runtime.delegateAuthority({
        issuerId: "mock-lead",
        subjectId: "mock-worker",
        missionId: fixture.result.mission.id,
        taskId: fixture.result.tasks[0]?.id,
        permissions: [globalPermission("production.delete")],
        constraints: [],
        riskLimits: [],
      });

      assert.equal(result.result, "deny");
      if (result.result === "deny") {
        assert.equal(result.violation.code, "INVALID_DELEGATION");
      }
      assert.equal(
        fixture.store
          .listAuthorityGrants(fixture.result.mission.id, "mock-worker")
          .some(({ permissions }) =>
            permissions.some(({ action }) => action === "production.delete"),
          ),
        false,
      );
    } finally {
      fixture.store.close();
    }
  });

  it("Scenario F: an inherited Commander constraint survives Worker delegation", async () => {
    const store = new SqliteStore();
    const roleAuthorities = runtimeAgentRoleAuthorities();
    const agents = createMockAgents({ lead: { plan: ONE_TASK_PLAN } });
    const runtime = new CommandControlRuntime(store, agents, {
      doctrine: { roleAuthorities },
    });
    try {
      const mission = await runtime.run({ goal: "Preserve inherited constraints" });
      const commanderGrant = await runtime.delegateAuthority({
        issuerId: "mock-commander",
        subjectId: "mock-lead",
        missionId: mission.mission.id,
        permissions: [],
        constraints: [
          {
            id: "commander-public-api-prohibition",
            sourceId: "mock-commander",
            kind: "prohibit",
            target: "public_api.modify",
            inherited: true,
          },
        ],
        riskLimits: [],
      });
      assert.equal(
        commanderGrant.result,
        "allow",
        commanderGrant.reason,
      );

      const result = await runtime.delegateAuthority({
        issuerId: "mock-lead",
        subjectId: "mock-worker",
        missionId: mission.mission.id,
        taskId: mission.tasks[0]?.id,
        permissions: [{
          action: "public_api.modify",
          resource: { type: "task", taskId: mission.tasks[0]!.id },
        }],
        constraints: [],
        riskLimits: [],
      });
      assert.equal(result.result, "deny");
      if (result.result === "deny") {
        assert.equal(
          result.violation.code,
          "CONSTRAINT_VIOLATION",
          result.reason,
        );
      }
    } finally {
      store.close();
    }
  });

  it("Scenario G: revoked Worker authority cannot be exercised", async () => {
    const fixture = await completedFixture();
    try {
      const taskId = fixture.result.tasks[0]?.id;
      assert.ok(taskId !== undefined);
      const grant = fixture.store
        .listAuthorityGrants(fixture.result.mission.id, "mock-worker")
        .find(({ taskId: candidate }) => candidate === taskId);
      assert.ok(grant !== undefined);

      const before = await fixture.runtime.authorizeDecision(
        request(fixture, "worker", "mock-worker", "execution.local_change", {
          taskId,
          resource: { type: "task", taskId },
        }),
      );
      assert.equal(before.result, "allow");

      const revoked = await fixture.runtime.revokeAuthority({
        actorId: "mock-lead",
        grantId: grant.id,
        reason: "The bounded operation is no longer needed",
      });
      assert.equal(revoked.result, "allow");
      assert.ok(
        fixture.store
          .listEvents(fixture.result.mission.id)
          .some(
            ({ type, actor, payload }) =>
              type === "DecisionRequested" &&
              actor === "mock-lead" &&
              typeof payload === "object" &&
              payload !== null &&
              !Array.isArray(payload) &&
              payload.decisionType === "authority.revoke",
          ),
      );
      assert.ok(
        fixture.store
          .listAuthorizationRecords(
            fixture.result.mission.id,
            "mock-lead",
          )
          .some(
            ({ decisionType, result }) =>
              decisionType === "authority.revoke" && result === "allow",
          ),
      );

      const after = await fixture.runtime.authorizeDecision(
        request(fixture, "worker", "mock-worker", "execution.local_change", {
          taskId,
          resource: { type: "task", taskId },
        }),
      );
      assert.equal(after.result, "deny");
      if (after.result === "deny") {
        assert.equal(after.violation.code, "REVOKED_AUTHORITY");
      }
      const withoutResource = await fixture.runtime.authorizeDecision(
        request(fixture, "worker", "mock-worker", "execution.local_change", {
          taskId,
        }),
      );
      assert.equal(withoutResource.result, "deny");
    } finally {
      fixture.store.close();
    }
  });

  it("Scenario H: Evaluator mutation is denied while evidence-based Runtime completion succeeds", async () => {
    const fixture = await completedFixture();
    try {
      const taskId = fixture.result.tasks[0]?.id;
      assert.ok(taskId !== undefined);
      const denied = await fixture.runtime.authorizeDecision(
        request(fixture, "evaluator", "mock-evaluator", "state.transition", {
          taskId,
          context: {
            entity: "task",
            from: "evaluating",
            to: "completed",
            evaluationResult: "pass",
          },
        }),
      );

      assert.equal(denied.result, "deny");
      if (denied.result === "deny") {
        assert.equal(denied.violation.code, "EVALUATOR_STATE_MUTATION");
      }
      const publicRuntimeAttempt = await fixture.runtime.authorizeDecision(
        request(fixture, "runtime", "runtime", "state.transition", {
          taskId,
          context: {
            entity: "task",
            entityId: taskId,
            from: "evaluating",
            to: "completed",
            evaluationResult: "pass",
          },
        }),
      );
      assert.equal(publicRuntimeAttempt.result, "deny");
      assert.equal(fixture.result.status, "completed");
      const types = fixture.result.events.map(({ type }) => type);
      assert.ok(types.indexOf("ReportSubmitted") < types.indexOf("EvaluationPassed"));
      assert.ok(types.indexOf("EvaluationPassed") < types.indexOf("TaskCompleted"));
      assert.equal(
        fixture.result.events.find(({ type }) => type === "TaskCompleted")?.actor,
        "runtime",
      );
    } finally {
      fixture.store.close();
    }
  });
});
