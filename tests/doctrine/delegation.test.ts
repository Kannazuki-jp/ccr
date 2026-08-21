import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import type {
  AuthorityGrant,
  Constraint,
  DecisionRequest,
  DelegationRequest,
} from "../../src/domain/index.js";
import { DoctrineEnforcer } from "../../src/runtime/doctrine/index.js";
import { MISSION_ID, TASK_ID, TestDoctrineStore } from "./test-store.js";

const START = new Date("2026-08-20T01:00:00.000Z");

function delegation(
  overrides: Partial<DelegationRequest> = {},
): DelegationRequest {
  return {
    issuerId: "lead-01",
    subjectId: "worker-01",
    missionId: MISSION_ID,
    taskId: TASK_ID,
    permissions: [
      {
        action: "code.edit",
        resource: { type: "path", pattern: "src/auth/**" },
      },
    ],
    constraints: [],
    riskLimits: [],
    ...overrides,
  };
}

function workerEdit(): DecisionRequest {
  return {
    id: randomUUID(),
    actorId: "worker-01",
    role: "worker",
    missionId: MISSION_ID,
    taskId: TASK_ID,
    decisionType: "execution.local_change",
    action: "code.edit",
    resource: { type: "path", pattern: "src/auth/session.ts" },
    createdAt: START,
  };
}

function explicitLeadGrant(
  permissions: AuthorityGrant["permissions"],
  constraints: Constraint[] = [],
  riskLimits: AuthorityGrant["riskLimits"] = [],
): AuthorityGrant {
  return {
    id: randomUUID(),
    issuerId: "commander-01",
    subjectId: "lead-01",
    missionId: MISSION_ID,
    permissions: [
      ...permissions,
      {
        action: "authority.delegate",
        resource: { type: "mission", missionId: MISSION_ID },
      },
    ],
    constraints,
    riskLimits,
    status: "active",
    createdAt: START,
  };
}

describe("Doctrine delegation invariants", () => {
  it("allows a narrower resource scope and persists inherited constraints", async () => {
    const store = new TestDoctrineStore();
    const inherited: Constraint = {
      id: "commander-no-public-api",
      sourceId: "commander-01",
      kind: "prohibit",
      target: "public_api.modify",
      inherited: true,
    };
    store.grants.push(
      explicitLeadGrant(
        [{ action: "code.edit", resource: { type: "path", pattern: "src/**" } }],
        [inherited],
      ),
    );
    const enforcer = new DoctrineEnforcer(store, { now: () => START });
    const result = await enforcer.delegate(delegation());

    assert.equal(result.result, "allow");
    assert.equal(result.result === "allow" && result.grant.constraints.length, 1);
    assert.deepEqual(
      result.result === "allow" && result.grant.constraints[0],
      inherited,
    );
    assert.equal(store.grants.length, 2);
    assert.ok(store.events.some(({ type }) => type === "AuthorityGranted"));
    assert.ok(store.events.some(({ type }) => type === "ConstraintApplied"));
  });

  it("denies authority creation outside the issuer effective scope", async () => {
    const store = new TestDoctrineStore();
    store.grants.push(
      explicitLeadGrant([
        {
          action: "code.edit",
          resource: { type: "path", pattern: "src/auth/**" },
        },
      ]),
    );
    const enforcer = new DoctrineEnforcer(store, { now: () => START });
    const result = await enforcer.delegate(
      delegation({
        permissions: [
          {
            action: "code.edit",
            resource: { type: "path", pattern: "src/**" },
          },
        ],
      }),
    );

    assert.equal(result.result, "deny");
    assert.equal(
      result.result === "deny" && result.violation.code,
      "INVALID_DELEGATION",
    );
  });

  it("denies permissions prohibited by a higher constraint", async () => {
    const store = new TestDoctrineStore();
    store.grants.push(
      explicitLeadGrant(
        [{ action: "public_api.modify", resource: { type: "global" } }],
        [
          {
            id: "no-public-api",
            sourceId: "commander-01",
            kind: "prohibit",
            target: "public_api.modify",
            inherited: true,
          },
        ],
      ),
    );
    const enforcer = new DoctrineEnforcer(store, { now: () => START });
    const result = await enforcer.delegate(
      delegation({
        permissions: [
          { action: "public_api.modify", resource: { type: "global" } },
        ],
      }),
    );

    assert.equal(result.result, "deny");
    assert.equal(
      result.result === "deny" && result.violation.code,
      "CONSTRAINT_VIOLATION",
    );
  });

  it("does not transfer Goal or Mission command ownership", async () => {
    const store = new TestDoctrineStore();
    store.grants.push(
      explicitLeadGrant([
        { action: "mission.scope.modify", resource: { type: "global" } },
      ]),
    );
    const enforcer = new DoctrineEnforcer(store, {
      now: () => START,
      roleAuthorities: [
        {
          subjectId: "lead-01",
          role: "lead",
          permissions: [
            { action: "mission.scope.modify", resource: { type: "global" } },
          ],
          constraints: [],
          riskLimits: [],
        },
        {
          subjectId: "worker-01",
          role: "worker",
          permissions: [
            { action: "mission.scope.modify", resource: { type: "global" } },
          ],
          constraints: [],
          riskLimits: [],
        },
      ],
    });
    const result = await enforcer.delegate(
      delegation({
        permissions: [
          { action: "mission.scope.modify", resource: { type: "global" } },
        ],
      }),
    );

    assert.equal(result.result, "deny");
    assert.equal(
      result.result === "deny" && result.violation.code,
      "INVALID_DELEGATION",
    );
  });

  it("revokes a grant atomically and rejects its later exercise", async () => {
    const store = new TestDoctrineStore();
    const enforcer = new DoctrineEnforcer(store, { now: () => START });
    const delegated = await enforcer.delegate(delegation());
    assert.equal(delegated.result, "allow");
    assert.equal((await enforcer.authorize(workerEdit())).result, "allow");
    if (delegated.result !== "allow") return;

    const revoked = await enforcer.revoke({
      actorId: "lead-01",
      grantId: delegated.grant.id,
      reason: "Mission boundary changed",
    });
    assert.equal(revoked.result, "allow");
    assert.ok(
      store.events.some(
        ({ type, payload }) =>
          type === "DecisionRequested" &&
          typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload) &&
          payload.decisionType === "authority.revoke",
      ),
    );
    const after = await enforcer.authorize(workerEdit());
    assert.equal(after.result, "deny");
    assert.equal(
      after.result === "deny" && after.violation.code,
      "REVOKED_AUTHORITY",
    );
    assert.ok(store.events.some(({ type }) => type === "AuthorityRevoked"));

    const withoutScope = await enforcer.authorize({
      ...workerEdit(),
      resource: undefined,
    });
    assert.equal(withoutScope.result, "deny");
    assert.equal(
      withoutScope.result === "deny" && withoutScope.violation.code,
      "INSUFFICIENT_AUTHORITY",
    );
  });

  it("rejects path traversal before delegation scope comparison", async () => {
    const store = new TestDoctrineStore();
    const enforcer = new DoctrineEnforcer(store, { now: () => START });
    await assert.rejects(
      enforcer.delegate(
        delegation({
          permissions: [
            {
              action: "code.edit",
              resource: { type: "path", pattern: "src/../secrets/**" },
            },
          ],
        }),
      ),
    );
    assert.equal(store.grants.length, 0);
    for (const absolute of ["/etc/passwd", "C:\\secrets\\token.txt", "\\\\server\\share\\token.txt"]) {
      await assert.rejects(
        enforcer.delegate(
          delegation({
            permissions: [
              {
                action: "code.edit",
                resource: { type: "path", pattern: absolute },
              },
            ],
          }),
        ),
      );
    }
  });

  it("expires authority at the explicit resolution time and reports EXPIRED_AUTHORITY", async () => {
    const store = new TestDoctrineStore();
    let now = new Date(START);
    const enforcer = new DoctrineEnforcer(store, { now: () => now });
    const delegated = await enforcer.delegate(
      delegation({ expiresAt: new Date("2026-08-20T02:00:00.000Z") }),
    );
    assert.equal(delegated.result, "allow");
    now = new Date("2026-08-20T03:00:00.000Z");

    const effective = await enforcer.resolveEffectiveAuthority("worker-01", {
      missionId: MISSION_ID,
      taskId: TASK_ID,
      role: "worker",
      at: now,
    });
    assert.deepEqual(effective.permissions, []);
    const expiration = store.events.find(({ type }) => type === "AuthorityExpired");
    assert.equal(expiration?.createdAt.toISOString(), now.toISOString());

    const after = await enforcer.authorize(workerEdit());
    assert.equal(after.result, "deny");
    assert.equal(
      after.result === "deny" && after.violation.code,
      "EXPIRED_AUTHORITY",
    );
  });

  it("rejects relaxation across risk operators", async () => {
    const store = new TestDoctrineStore();
    store.tasks[0] = { ...store.tasks[0]!, risk: { cost: 5 } };
    store.grants.push(
      explicitLeadGrant(
        [{ action: "code.edit", resource: { type: "global" } }],
        [],
        [{ dimension: "cost", operator: "lt", value: 100 }],
      ),
    );
    const enforcer = new DoctrineEnforcer(store, { now: () => START });
    const result = await enforcer.delegate(
      delegation({
        riskLimits: [{ dimension: "cost", operator: "lte", value: 100 }],
      }),
    );

    assert.equal(result.result, "deny");
    assert.equal(
      result.result === "deny" && result.violation.code,
      "INVALID_DELEGATION",
    );
  });

  it("rejects self, upward, unauthorized Human, and unassigned-worker delegation", async () => {
    const self = await new DoctrineEnforcer(new TestDoctrineStore(), {
      now: () => START,
    }).delegate(
      delegation({ issuerId: "lead-01", subjectId: "lead-01" }),
    );
    const upward = await new DoctrineEnforcer(new TestDoctrineStore(), {
      now: () => START,
    }).delegate(
      delegation({ issuerId: "worker-01", subjectId: "lead-01" }),
    );
    const human = await new DoctrineEnforcer(new TestDoctrineStore(), {
      now: () => START,
    }).delegate(
      delegation({ issuerId: "human", subjectId: "commander-01", taskId: undefined }),
    );
    const unassignedStore = new TestDoctrineStore();
    unassignedStore.tasks[0] = {
      ...unassignedStore.tasks[0]!,
      assignedAgentId: undefined,
    };
    const unassigned = await new DoctrineEnforcer(unassignedStore, {
      now: () => START,
    }).delegate(delegation());

    for (const result of [self, upward, human, unassigned]) {
      assert.equal(result.result, "deny");
      assert.equal(
        result.result === "deny" && result.violation.code,
        "INVALID_DELEGATION",
      );
    }
  });

  it("rejects a cross-Mission task delegation", async () => {
    const store = new TestDoctrineStore();
    const otherMissionId = randomUUID();
    const otherTaskId = randomUUID();
    store.missions.push({ ...store.missions[0]!, id: otherMissionId });
    store.tasks.push({
      ...store.tasks[0]!,
      id: otherTaskId,
      missionId: otherMissionId,
    });
    const result = await new DoctrineEnforcer(store, {
      now: () => START,
    }).delegate(delegation({ taskId: otherTaskId }));

    assert.equal(result.result, "deny");
    assert.equal(
      result.result === "deny" && result.violation.code,
      "INVALID_DELEGATION",
    );
  });

  it("records only the task-scoped parent grant that covers the child permission", async () => {
    const store = new TestDoctrineStore();
    const covering = explicitLeadGrant([
      {
        action: "code.edit",
        resource: { type: "task", taskId: TASK_ID },
      },
    ]);
    const unrelated = explicitLeadGrant([
      { action: "code.read", resource: { type: "global" } },
    ]);
    store.grants.push(covering, unrelated);
    const enforcer = new DoctrineEnforcer(store, { now: () => START });
    const delegated = await enforcer.delegate(delegation());

    assert.equal(delegated.result, "allow");
    assert.deepEqual(
      delegated.result === "allow" && delegated.grant.parentGrantIds,
      [covering.id],
    );
    const unrelatedRevocation = await enforcer.revoke({
      actorId: "commander-01",
      grantId: unrelated.id,
      reason: "Unrelated authority withdrawn",
    });
    assert.equal(unrelatedRevocation.result, "allow");
    assert.equal((await enforcer.authorize(workerEdit())).result, "allow");
  });

  it("bounds child expiry by its selected parent and invalidates descendants with ancestors", async () => {
    const parentExpiry = new Date("2026-08-20T04:00:00.000Z");

    for (const expiresAt of [
      undefined,
      new Date("2026-08-20T05:00:00.000Z"),
    ]) {
      const store = new TestDoctrineStore();
      store.grants.push({
        ...explicitLeadGrant([
          { action: "code.edit", resource: { type: "global" } },
        ]),
        expiresAt: parentExpiry,
      });
      const result = await new DoctrineEnforcer(store, {
        now: () => START,
      }).delegate(delegation({ expiresAt }));
      assert.equal(result.result, "deny");
      assert.equal(
        result.result === "deny" && result.violation.code,
        "INVALID_DELEGATION",
      );
    }

    const store = new TestDoctrineStore();
    const parent = {
      ...explicitLeadGrant([
        { action: "code.edit", resource: { type: "global" } },
      ]),
      expiresAt: parentExpiry,
    };
    store.grants.push(parent);
    const enforcer = new DoctrineEnforcer(store, { now: () => START });
    const delegated = await enforcer.delegate(
      delegation({ expiresAt: new Date("2026-08-20T03:00:00.000Z") }),
    );
    assert.equal(delegated.result, "allow");
    assert.deepEqual(
      delegated.result === "allow" && delegated.grant.parentGrantIds,
      [parent.id],
    );
    assert.equal((await enforcer.authorize(workerEdit())).result, "allow");

    await enforcer.revoke({
      actorId: "commander-01",
      grantId: parent.id,
      reason: "Parent authority withdrawn",
    });
    const afterParentRevocation = await enforcer.authorize(workerEdit());
    assert.equal(afterParentRevocation.result, "deny");
  });

  it("rejects a permission that conflicts with a constraint attached in the same delegation", async () => {
    const store = new TestDoctrineStore();
    const result = await new DoctrineEnforcer(store, {
      now: () => START,
    }).delegate(
      delegation({
        permissions: [
          { action: "public_api.modify", resource: { type: "global" } },
        ],
        constraints: [
          {
            id: "commander-no-public-api",
            sourceId: "commander-01",
            kind: "prohibit",
            target: "public_api.modify",
            scope: { type: "mission", missionId: MISSION_ID },
            inherited: true,
          },
        ],
      }),
    );

    assert.equal(result.result, "deny");
    assert.equal(
      result.result === "deny" && result.violation.code,
      "CONSTRAINT_VIOLATION",
    );
  });

  it("requires lifecycle permission for direct delegate and revoke methods", async () => {
    const delegateStore = new TestDoctrineStore();
    const delegateResult = await new DoctrineEnforcer(delegateStore, {
      now: () => START,
      roleAuthorities: [
        {
          subjectId: "lead-01",
          role: "lead",
          permissions: [
            { action: "code.edit", resource: { type: "global" } },
          ],
          constraints: [],
          riskLimits: [],
        },
      ],
    }).delegate(delegation());
    assert.equal(delegateResult.result, "deny");

    const revokeStore = new TestDoctrineStore();
    const grant = delegation({ permissions: [] });
    const storedGrant: AuthorityGrant = {
      id: randomUUID(),
      issuerId: grant.issuerId,
      subjectId: grant.subjectId,
      missionId: grant.missionId,
      taskId: grant.taskId,
      permissions: [],
      constraints: [],
      riskLimits: [],
      status: "active",
      createdAt: START,
    };
    revokeStore.grants.push(storedGrant);
    const revokeResult = await new DoctrineEnforcer(revokeStore, {
      now: () => START,
      roleAuthorities: [
        {
          subjectId: "lead-01",
          role: "lead",
          permissions: [],
          constraints: [],
          riskLimits: [],
        },
      ],
    }).revoke({
      actorId: "lead-01",
      grantId: storedGrant.id,
      reason: "Attempt without lifecycle authority",
    });
    assert.equal(revokeResult.result, "deny");

    const riskStore = new TestDoctrineStore();
    riskStore.tasks[0] = { ...riskStore.tasks[0]!, risk: { cost: 99 } };
    const riskyGrant: AuthorityGrant = {
      ...storedGrant,
      id: randomUUID(),
    };
    riskStore.grants.push(riskyGrant);
    const safetyRevocation = await new DoctrineEnforcer(riskStore, {
      now: () => START,
      roleAuthorities: [
        {
          subjectId: "lead-01",
          role: "lead",
          permissions: [
            {
              action: "authority.delegate",
              resource: { type: "task", taskId: TASK_ID },
            },
          ],
          constraints: [],
          riskLimits: [{ dimension: "cost", operator: "lte", value: 10 }],
        },
      ],
    }).revoke({
      actorId: "lead-01",
      grantId: riskyGrant.id,
      reason: "Reduce authority after risk increased",
    });
    assert.equal(safetyRevocation.result, "allow");
  });
});
