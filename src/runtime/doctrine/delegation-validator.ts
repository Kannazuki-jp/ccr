import type {
  AuthorityGrant,
  Constraint,
  DelegationRequest,
  DoctrineActorRole,
  DoctrineViolation,
  EffectiveAuthority,
  RiskLimit,
} from "../../domain/index.js";
import { DecisionTypeSchema } from "../../domain/index.js";

import {
  getDecisionOwner,
  isNonTransferableCommandDecision,
} from "./boundary-registry.js";
import { permissionConflictsWithConstraint } from "./constraint-checker.js";
import { permissionContainsInContext } from "./permission.js";
import { riskLimitIsAtLeastAsStrict } from "./risk-checker.js";

export interface DelegationValidationSuccess {
  readonly ok: true;
  readonly constraints: Constraint[];
  readonly riskLimits: RiskLimit[];
}

export interface DelegationValidationFailure {
  readonly ok: false;
  readonly violation: DoctrineViolation;
}

export type DelegationValidationResult =
  | DelegationValidationSuccess
  | DelegationValidationFailure;

export function validateDelegation(
  request: DelegationRequest,
  issuerAuthority: EffectiveAuthority,
  subjectRole: DoctrineActorRole,
  now: Date,
): DelegationValidationResult {
  for (const permission of request.permissions) {
    if (
      !issuerAuthority.permissions.some((parent) =>
        permissionContainsInContext(parent, permission, {
          missionId: request.missionId,
          ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        }),
      )
    ) {
      return failure(
        request,
        "INVALID_DELEGATION",
        `Issuer does not possess ${permission.action} for the requested resource`,
        now,
      );
    }

    const decisionType = DecisionTypeSchema.safeParse(permission.action);
    if (
      decisionType.success &&
      isNonTransferableCommandDecision(decisionType.data) &&
      getDecisionOwner(decisionType.data) !== subjectRole
    ) {
      return failure(
        request,
        "INVALID_DELEGATION",
        `Command ownership for ${permission.action} cannot be delegated to ${subjectRole}`,
        now,
      );
    }

    const conflict = issuerAuthority.constraints.find((constraint) =>
      permissionConflictsWithConstraint(
        permission.action,
        permission.resource,
        constraint,
        {
          missionId: request.missionId,
          ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        },
      ),
    );
    if (conflict !== undefined) {
      return failure(
        request,
        "CONSTRAINT_VIOLATION",
        `Permission ${permission.action} conflicts with inherited constraint ${conflict.id}`,
        now,
      );
    }
  }

  const constraints = mergeConstraints(
    issuerAuthority.constraints,
    request.constraints,
  );
  if (constraints === undefined) {
    return failure(
      request,
      "CONSTRAINT_VIOLATION",
      "Delegation attempts to replace an inherited constraint",
      now,
    );
  }
  for (const permission of request.permissions) {
    const conflict = constraints.find((constraint) =>
      permissionConflictsWithConstraint(
        permission.action,
        permission.resource,
        constraint,
        {
          missionId: request.missionId,
          ...(request.taskId === undefined
            ? {}
            : { taskId: request.taskId }),
        },
      ),
    );
    if (conflict !== undefined) {
      return failure(
        request,
        "CONSTRAINT_VIOLATION",
        `Permission ${permission.action} conflicts with delegated constraint ${conflict.id}`,
        now,
      );
    }
  }

  const riskLimits = mergeRiskLimits(
    issuerAuthority.riskLimits,
    request.riskLimits,
  );
  if (riskLimits === undefined) {
    return failure(
      request,
      "INVALID_DELEGATION",
      "Delegation attempts to relax an inherited risk limit",
      now,
    );
  }

  return { ok: true, constraints, riskLimits };
}

export function grantAppliesToContext(
  grant: AuthorityGrant,
  missionId: string,
  taskId?: string,
): boolean {
  return (
    grant.missionId === missionId &&
    (grant.taskId === undefined || grant.taskId === taskId)
  );
}

function mergeConstraints(
  parent: readonly Constraint[],
  child: readonly Constraint[],
): Constraint[] | undefined {
  const result = [...child];
  for (const inherited of parent) {
    const replacementIndex = child.findIndex(({ id }) => id === inherited.id);
    const replacement = child[replacementIndex];
    if (
      replacement !== undefined &&
      JSON.stringify(replacement) !==
        JSON.stringify({ ...inherited, inherited: true }) &&
      JSON.stringify(replacement) !== JSON.stringify(inherited)
    ) {
      return undefined;
    }
    if (replacement === undefined) {
      result.push({ ...inherited, inherited: true });
    } else {
      result[replacementIndex] = { ...inherited, inherited: true };
    }
  }
  return result;
}

function mergeRiskLimits(
  parent: readonly RiskLimit[],
  child: readonly RiskLimit[],
): RiskLimit[] | undefined {
  const result = [...child];
  for (const inherited of parent) {
    const replacements = child.filter(
      ({ dimension }) => dimension === inherited.dimension,
    );
    if (
      replacements.length > 0 &&
      !replacements.every((candidate) =>
        riskLimitIsAtLeastAsStrict(candidate, inherited),
      )
    ) {
      return undefined;
    }
    if (replacements.length === 0) result.push(inherited);
  }
  return result;
}

function failure(
  request: DelegationRequest,
  code: DoctrineViolation["code"],
  message: string,
  now: Date,
): DelegationValidationFailure {
  return {
    ok: false,
    violation: {
      code,
      actorId: request.issuerId,
      decisionType: "authority.delegate",
      message,
      createdAt: now,
    },
  };
}
