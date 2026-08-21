import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import type {
  AuthorityGrant,
  DecisionRequest,
  RoleAuthority,
} from "../../src/domain/index.js";
import { DoctrineEnforcer } from "../../src/runtime/doctrine/index.js";
import { MISSION_ID, TASK_ID, TestDoctrineStore } from "./test-store.js";

const NOW = new Date("2026-08-20T01:00:00.000Z");

function workerGrant(
  overrides: Partial<AuthorityGrant> = {},
): AuthorityGrant {
  return {
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
    ...overrides,
  };
}

function editRequest(
  overrides: Partial<DecisionRequest> = {},
): DecisionRequest {
  return {
    id: randomUUID(),
    actorId: "worker-01",
    role: "worker",
    missionId: MISSION_ID,
    taskId: TASK_ID,
    decisionType: "execution.local_change",
    action: "code.edit",
    resource: { type: "path", pattern: "src/index.ts" },
    createdAt: NOW,
    ...overrides,
  };
}

describe("Effective authority, constraints, and risk", () => {
  it("intersects explicit grants with the exact subject's role authority", async () => {
    const store = new TestDoctrineStore();
    store.grants.push(workerGrant());
    const roleAuthorities: RoleAuthority[] = [
      {
        subjectId: "someone-else",
        role: "worker",
        permissions: [
          { action: "code.edit", resource: { type: "global" } },
        ],
        constraints: [],
        riskLimits: [],
      },
    ];
    const enforcer = new DoctrineEnforcer(store, { roleAuthorities });

    const effective = await enforcer.resolveEffectiveAuthority("worker-01", {
      missionId: MISSION_ID,
      taskId: TASK_ID,
      role: "worker",
    });
    assert.deepEqual(effective.permissions, []);
    const result = await enforcer.authorize(editRequest());
    assert.equal(result.result, "deny");
    assert.equal(
      result.result === "deny" && result.violation.code,
      "INSUFFICIENT_AUTHORITY",
    );
  });

  it("denies a prohibited action even when its permission is present", async () => {
    const store = new TestDoctrineStore();
    store.grants.push(
      workerGrant({
        constraints: [
          {
            id: "no-code-edit",
            sourceId: "commander-01",
            kind: "prohibit",
            target: "code.edit",
            scope: { type: "path", pattern: "src/**" },
            inherited: true,
          },
        ],
      }),
    );
    const result = await new DoctrineEnforcer(store).authorize(editRequest());

    assert.equal(result.result, "deny");
    assert.equal(
      result.result === "deny" && result.violation.code,
      "CONSTRAINT_VIOLATION",
    );
    assert.equal(
      store.events.filter(({ type }) => type === "ConstraintViolationDetected").length,
      1,
    );
  });

  it("rejects replacement of a commander constraint while permitting a stricter addition", async () => {
    const parentConstraint = {
      id: "required-mode",
      sourceId: "commander-01",
      kind: "require" as const,
      target: "review_mode",
      value: "strict",
      inherited: true,
    };

    const relaxingStore = new TestDoctrineStore();
    relaxingStore.grants.push({
      ...workerGrant({ subjectId: "lead-01", issuerId: "commander-01", taskId: undefined }),
      permissions: [
        { action: "code.edit", resource: { type: "global" } },
        {
          action: "authority.delegate",
          resource: { type: "mission", missionId: MISSION_ID },
        },
      ],
      constraints: [parentConstraint],
    });
    const relaxing = await new DoctrineEnforcer(relaxingStore).delegate({
      issuerId: "lead-01",
      subjectId: "worker-01",
      missionId: MISSION_ID,
      taskId: TASK_ID,
      permissions: [
        { action: "code.edit", resource: { type: "path", pattern: "src/**" } },
      ],
      constraints: [{ ...parentConstraint, value: "optional" }],
      riskLimits: [],
    });
    assert.equal(relaxing.result, "deny");
    assert.equal(
      relaxing.result === "deny" && relaxing.violation.code,
      "CONSTRAINT_VIOLATION",
    );

    const stricterStore = new TestDoctrineStore();
    const stricter = await new DoctrineEnforcer(stricterStore).delegate({
      issuerId: "lead-01",
      subjectId: "worker-01",
      missionId: MISSION_ID,
      taskId: TASK_ID,
      permissions: [
        { action: "code.edit", resource: { type: "path", pattern: "src/**" } },
      ],
      constraints: [
        {
          id: "worker-no-generated",
          sourceId: "lead-01",
          kind: "prohibit",
          target: "generated.edit",
          inherited: false,
        },
      ],
      riskLimits: [],
    });
    assert.equal(stricter.result, "allow");
    assert.equal(stricter.result === "allow" && stricter.grant.constraints.length, 1);
  });

  it("evaluates every numeric risk operator deterministically", async () => {
    const cases = [
      { operator: "lt" as const, value: 10, actual: 10 },
      { operator: "lte" as const, value: 10, actual: 11 },
      { operator: "eq" as const, value: 10, actual: 9 },
    ];
    for (const testCase of cases) {
      const store = new TestDoctrineStore();
      store.grants.push(
        workerGrant({
          riskLimits: [
            {
              dimension: "cost",
              operator: testCase.operator,
              value: testCase.value,
            },
          ],
        }),
      );
      const result = await new DoctrineEnforcer(store).authorize(
        editRequest({ context: { risk: { cost: testCase.actual } } }),
      );
      assert.equal(result.result, "deny");
      assert.equal(
        result.result === "deny" && result.violation.code,
        "RISK_LIMIT_EXCEEDED",
      );
    }
  });

  it("does not allow callers to omit required risk measurements or resource scope", async () => {
    const riskStore = new TestDoctrineStore();
    riskStore.grants.push(
      workerGrant({
        riskLimits: [{ dimension: "cost", operator: "lte", value: 10 }],
      }),
    );
    const missingRisk = await new DoctrineEnforcer(riskStore).authorize(
      editRequest(),
    );
    assert.equal(missingRisk.result, "deny");
    assert.equal(
      missingRisk.result === "deny" && missingRisk.violation.code,
      "RISK_LIMIT_EXCEEDED",
    );

    const scopeStore = new TestDoctrineStore();
    const missingScope = await new DoctrineEnforcer(scopeStore).authorize(
      editRequest({ resource: undefined }),
    );
    assert.equal(missingScope.result, "deny");
    assert.equal(
      missingScope.result === "deny" && missingScope.violation.code,
      "INSUFFICIENT_AUTHORITY",
    );
  });

  it("rejects an authorization path containing parent traversal", async () => {
    const store = new TestDoctrineStore();
    await assert.rejects(
      new DoctrineEnforcer(store).authorize(
        editRequest({
          resource: { type: "path", pattern: "src/../secrets/token.ts" },
        }),
      ),
    );
    assert.equal(store.authorizations.length, 0);
  });

  it("applies context requirements to in-scope actions", async () => {
    const store = new TestDoctrineStore();
    store.grants.push(
      workerGrant({
        constraints: [
          {
            id: "strict-review",
            sourceId: "commander-01",
            kind: "require",
            target: "review_mode",
            value: "strict",
            inherited: true,
          },
        ],
      }),
    );
    const enforcer = new DoctrineEnforcer(store);

    const missing = await enforcer.authorize(editRequest());
    const satisfied = await enforcer.authorize(
      editRequest({ context: { review_mode: "strict" } }),
    );

    assert.equal(missing.result, "deny");
    assert.equal(
      missing.result === "deny" && missing.violation.code,
      "CONSTRAINT_VIOLATION",
    );
    assert.equal(satisfied.result, "allow");
  });

  it("applies Mission-scoped permission and constraints to a task in that Mission", async () => {
    const store = new TestDoctrineStore();
    store.grants.push(
      workerGrant({
        permissions: [
          {
            action: "code.edit",
            resource: { type: "mission", missionId: MISSION_ID },
          },
        ],
        constraints: [
          {
            id: "mission-no-edit",
            sourceId: "commander-01",
            kind: "prohibit",
            target: "code.edit",
            scope: { type: "mission", missionId: MISSION_ID },
            inherited: true,
          },
        ],
      }),
    );
    const result = await new DoctrineEnforcer(store).authorize(editRequest());

    assert.equal(result.result, "deny");
    assert.equal(
      result.result === "deny" && result.violation.code,
      "CONSTRAINT_VIOLATION",
    );
  });

  it("requires approval only for the action named by the approval constraint", async () => {
    const store = new TestDoctrineStore();
    store.grants.push(
      workerGrant({
        permissions: [
          { action: "code.read", resource: { type: "path", pattern: "src/**" } },
          { action: "code.edit", resource: { type: "path", pattern: "src/**" } },
          {
            action: "execution.local_change",
            resource: { type: "task", taskId: TASK_ID },
          },
        ],
        constraints: [
          {
            id: "approve-edit",
            sourceId: "lead-01",
            kind: "require",
            target: "runtime.approval",
            value: "code.edit",
            scope: { type: "task", taskId: TASK_ID },
            inherited: true,
          },
        ],
      }),
    );
    const enforcer = new DoctrineEnforcer(store);
    const read = await enforcer.authorize(
      editRequest({ action: "code.read" }),
    );
    const unapprovedEdit = await enforcer.authorize(editRequest());
    const approvedEdit = await enforcer.authorize(
      editRequest({ context: { approvedActions: ["code.edit"] } }),
    );
    const genericAlias = await enforcer.authorize(
      editRequest({
        action: "execution.local_change",
        resource: undefined,
        context: { approval: true },
      }),
    );

    assert.equal(read.result, "allow");
    assert.equal(unapprovedEdit.result, "deny");
    assert.equal(approvedEdit.result, "deny");
    assert.equal(genericAlias.result, "deny");
  });

  it("uses persisted Task risk instead of caller-provided measurements", async () => {
    const store = new TestDoctrineStore();
    store.tasks[0] = { ...store.tasks[0]!, risk: { cost: 20 } };
    store.grants.push(
      workerGrant({
        riskLimits: [{ dimension: "cost", operator: "lte", value: 10 }],
      }),
    );
    const enforcer = new DoctrineEnforcer(store);

    const omitted = await enforcer.authorize(editRequest());
    const forgedLow = await enforcer.authorize(
      editRequest({ context: { risk: { cost: 1 } } }),
    );

    for (const result of [omitted, forgedLow]) {
      assert.equal(result.result, "deny");
      assert.equal(
        result.result === "deny" && result.violation.code,
        "RISK_LIMIT_EXCEEDED",
      );
    }
  });

  it("uses persisted Mission risk for Lead decisions", async () => {
    const store = new TestDoctrineStore();
    store.missions[0] = {
      ...store.missions[0]!,
      intent: { ...store.missions[0]!.intent, risk: { cost: 99 } },
    };
    const enforcer = new DoctrineEnforcer(store, {
      roleAuthorities: [
        {
          subjectId: "lead-01",
          role: "lead",
          permissions: [
            {
              action: "plan.modify",
              resource: { type: "mission", missionId: MISSION_ID },
            },
          ],
          constraints: [],
          riskLimits: [{ dimension: "cost", operator: "lte", value: 10 }],
        },
      ],
    });
    const base: DecisionRequest = {
      id: randomUUID(),
      actorId: "lead-01",
      role: "lead",
      missionId: MISSION_ID,
      decisionType: "plan.modify",
      action: "plan.modify",
      createdAt: NOW,
    };

    const omitted = await enforcer.authorize(base);
    const forgedLow = await enforcer.authorize({
      ...base,
      id: randomUUID(),
      context: { risk: { cost: 1 } },
    });
    for (const result of [omitted, forgedLow]) {
      assert.equal(result.result, "deny");
      assert.equal(
        result.result === "deny" && result.violation.code,
        "RISK_LIMIT_EXCEEDED",
      );
    }

    const missingStore = new TestDoctrineStore();
    const missing = await new DoctrineEnforcer(missingStore, {
      roleAuthorities: [
        {
          subjectId: "lead-01",
          role: "lead",
          permissions: [
            {
              action: "plan.modify",
              resource: { type: "mission", missionId: MISSION_ID },
            },
          ],
          constraints: [],
          riskLimits: [{ dimension: "cost", operator: "lte", value: 10 }],
        },
      ],
    }).authorize(base);
    assert.equal(missing.result, "deny");
    assert.equal(
      missing.result === "deny" && missing.violation.code,
      "RISK_LIMIT_EXCEEDED",
    );
  });

  it("uses Task risk for Lead-owned Task decisions", async () => {
    const store = new TestDoctrineStore();
    store.missions[0] = {
      ...store.missions[0]!,
      intent: { ...store.missions[0]!.intent, risk: { cost: 1 } },
    };
    store.tasks[0] = { ...store.tasks[0]!, risk: { cost: 99 } };
    const enforcer = new DoctrineEnforcer(store, {
      roleAuthorities: [
        {
          subjectId: "lead-01",
          role: "lead",
          permissions: [
            { action: "task.modify", resource: { type: "task", taskId: TASK_ID } },
            { action: "task.assign", resource: { type: "task", taskId: TASK_ID } },
          ],
          constraints: [],
          riskLimits: [{ dimension: "cost", operator: "lte", value: 10 }],
        },
      ],
    });

    for (const decisionType of ["task.modify", "task.assign"] as const) {
      const result = await enforcer.authorize({
        id: randomUUID(),
        actorId: "lead-01",
        role: "lead",
        missionId: MISSION_ID,
        taskId: TASK_ID,
        decisionType,
        action: decisionType,
        context: { risk: { cost: 1 } },
        createdAt: NOW,
      });
      assert.equal(result.result, "deny");
      assert.equal(
        result.result === "deny" && result.violation.code,
        "RISK_LIMIT_EXCEEDED",
      );
    }
  });
});
