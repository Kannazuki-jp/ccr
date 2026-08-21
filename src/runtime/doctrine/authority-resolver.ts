import type {
  AuthorityContext,
  AuthorityGrant,
  Constraint,
  DoctrineActorRole,
  EffectiveAuthority,
  Event,
  Permission,
  RiskLimit,
  RoleAuthority,
} from "../../domain/index.js";
import { AuthorityContextSchema } from "../../domain/index.js";

import { permissionContains } from "./permission.js";
import type { DoctrineStore } from "./repository.js";

const DEFAULT_ROLE_ACTIONS = {
  human: ["*"],
  commander: [
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
  ],
  lead: [
    "task.*",
    "plan.modify",
    "authority.delegate",
    "execution.*",
    "report.submit",
    "code.*",
    "public_api.modify",
    "test.run",
    "tool.select",
  ],
  worker: [
    "execution.*",
    "report.submit",
    "code.read",
    "code.edit",
    "public_api.modify",
    "test.run",
    "tool.select",
  ],
  evaluator: ["evaluation.*"],
  runtime: ["state.transition", "authority.revoke"],
} as const satisfies Record<DoctrineActorRole, readonly string[]>;

export interface AuthorityResolverOptions {
  readonly roleAuthorities?: readonly RoleAuthority[];
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export class AuthorityResolver {
  private readonly now: () => Date;
  private readonly createId: () => string;

  public constructor(
    private readonly store: DoctrineStore,
    private readonly options: AuthorityResolverOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  public resolve(
    actorId: string,
    contextInput: AuthorityContext,
  ): EffectiveAuthority {
    const context = AuthorityContextSchema.parse(contextInput);
    const at = context.at ?? this.now();
    const roleAuthority = this.roleAuthority(actorId, context.role);
    const subjectMissionGrants = this.store.listAuthorityGrants(
      context.missionId,
      actorId,
    );
    const relevantGrants = subjectMissionGrants
      .filter(
        (grant) =>
          grant.taskId === undefined || grant.taskId === context.taskId,
      );
    const activeGrants: AuthorityGrant[] = [];

    for (const grant of relevantGrants) {
      if (
        grant.status === "active" &&
        grant.expiresAt !== undefined &&
        grant.expiresAt <= at
      ) {
        this.store.expireAuthorityGrant(
          grant.id,
          this.event(
            grant.missionId,
            "AuthorityExpired",
            "runtime",
            {
              grantId: grant.id,
              subjectId: grant.subjectId,
            },
            at,
          ),
        );
        continue;
      }
      if (
        grant.status === "active" &&
        this.hasActiveLineage(grant, at, new Set([grant.id]))
      ) {
        activeGrants.push(grant);
      }
    }

    // v0.1 missions did not persist bootstrap grants. Until a subject receives
    // its first explicit grant, its validated Role Authority is the implicit
    // mission delegation. Once grants exist, revocation/expiry cannot reveal
    // that fallback authority again.
    const permissions =
      subjectMissionGrants.length === 0 && context.role !== "worker"
        ? roleAuthority.permissions
        : activeGrants.flatMap((grant) =>
            grant.permissions.filter((permission) =>
              roleAuthority.permissions.some((maximum) =>
                permissionContains(maximum, permission),
              ),
            ),
          );
    const grantConstraints =
      subjectMissionGrants.length === 0 && context.role !== "worker"
        ? []
        : activeGrants.flatMap(({ constraints }) => constraints);
    const grantRiskLimits =
      subjectMissionGrants.length === 0 && context.role !== "worker"
        ? []
        : activeGrants.flatMap(({ riskLimits }) => riskLimits);

    return {
      subjectId: actorId,
      missionId: context.missionId,
      ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
      permissions: uniqueByJson(permissions),
      constraints: uniqueByJson([
        ...roleAuthority.constraints,
        ...grantConstraints,
        ...(context.currentConstraints ?? []),
      ]),
      riskLimits: uniqueByJson([
        ...roleAuthority.riskLimits,
        ...grantRiskLimits,
        ...(context.currentRiskLimits ?? []),
      ]),
      grantIds: activeGrants.map(({ id }) => id),
    };
  }

  public roleAuthority(
    actorId: string,
    role: DoctrineActorRole,
  ): RoleAuthority {
    if (this.options.roleAuthorities !== undefined) {
      const configured = this.options.roleAuthorities.find(
        (authority) =>
          authority.subjectId === actorId && authority.role === role,
      );
      return (
        configured ?? {
          subjectId: actorId,
          role,
          permissions: [],
          constraints: [],
          riskLimits: [],
        }
      );
    }

    return {
      subjectId: actorId,
      role,
      permissions: DEFAULT_ROLE_ACTIONS[role].map((action): Permission => ({
        action,
        resource: { type: "global" },
      })),
      constraints: [],
      riskLimits: [],
    };
  }

  private hasActiveLineage(
    grant: AuthorityGrant,
    at: Date,
    visited: Set<string>,
  ): boolean {
    for (const parentId of grant.parentGrantIds ?? []) {
      if (visited.has(parentId)) return false;
      const parent = this.store.getAuthorityGrant(parentId);
      if (parent === undefined || parent.status !== "active") return false;
      if (parent.expiresAt !== undefined && parent.expiresAt <= at) {
        this.store.expireAuthorityGrant(
          parent.id,
          this.event(
            parent.missionId,
            "AuthorityExpired",
            "runtime",
            { grantId: parent.id, subjectId: parent.subjectId },
            at,
          ),
        );
        return false;
      }
      const nextVisited = new Set(visited);
      nextVisited.add(parentId);
      if (!this.hasActiveLineage(parent, at, nextVisited)) return false;
    }
    return true;
  }

  private event(
    missionId: string,
    type: string,
    actor: string,
    payload: Event["payload"],
    createdAt = this.now(),
  ): Event {
    return {
      id: this.createId(),
      missionId,
      type,
      actor,
      payload,
      createdAt,
    };
  }
}

function uniqueByJson<T extends Permission | Constraint | RiskLimit>(
  values: readonly T[],
): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
