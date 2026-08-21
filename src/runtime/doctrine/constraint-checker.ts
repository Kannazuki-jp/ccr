import type {
  Constraint,
  DecisionRequest,
  DoctrineViolation,
} from "../../domain/index.js";

import { scopeContains } from "./permission.js";
import { isCanonicalAction } from "./decision-contract.js";

export function findConstraintViolation(
  request: DecisionRequest,
  constraints: readonly Constraint[],
  now: Date,
): DoctrineViolation | undefined {
  for (const constraint of constraints) {
    if (!constraintAppliesToScope(constraint, request)) continue;
    if (
      constraint.kind === "require" &&
      constraint.target === "runtime.approval" &&
      typeof constraint.value === "string" &&
      !actionSpecificTargetMatches(constraint.value, request)
    ) {
      continue;
    }

    if (
      constraint.kind === "prohibit" &&
      actionSpecificTargetMatches(constraint.target, request)
    ) {
      return violation(
        request,
        `Constraint ${constraint.id} prohibits ${constraint.target}`,
        now,
      );
    }
    if (constraint.kind === "require" && !requirementSatisfied(constraint, request)) {
      return violation(
        request,
        `Constraint ${constraint.id} requires ${constraint.target}`,
        now,
      );
    }
    if (constraint.kind === "limit" && limitExceeded(constraint, request)) {
      return violation(
        request,
        `Constraint ${constraint.id} limit for ${constraint.target} was exceeded`,
        now,
      );
    }
  }
  return undefined;
}

export function permissionConflictsWithConstraint(
  action: string,
  scope: import("../../domain/index.js").ResourceScope,
  constraint: Constraint,
  context?: { readonly missionId: string; readonly taskId?: string },
): boolean {
  return (
    constraint.kind === "prohibit" &&
    targetMatches(constraint.target, action) &&
    (constraint.scope === undefined ||
      constraintScopeApplies(constraint.scope, scope, context))
  );
}

function constraintAppliesToScope(
  constraint: Constraint,
  request: DecisionRequest,
): boolean {
  return (
    constraint.scope === undefined ||
    constraintScopeApplies(
      constraint.scope,
      request.resource,
      { missionId: request.missionId, ...(request.taskId === undefined ? {} : { taskId: request.taskId }) },
    )
  );
}

function constraintScopeApplies(
  constraintScope: import("../../domain/index.js").ResourceScope,
  requestScope: import("../../domain/index.js").ResourceScope | undefined,
  context?: { readonly missionId: string; readonly taskId?: string },
): boolean {
  if (constraintScope.type === "mission") {
    return context?.missionId === constraintScope.missionId;
  }
  if (constraintScope.type === "task") {
    return context?.taskId === constraintScope.taskId;
  }
  return requestScope !== undefined && scopeContains(constraintScope, requestScope);
}

function targetMatches(target: string, value: string): boolean {
  return target === "*" || target === value ||
    (target.endsWith(".*") && value.startsWith(target.slice(0, -1)));
}

function actionSpecificTargetMatches(
  target: string,
  request: DecisionRequest,
): boolean {
  if (
    targetMatches(target, request.action) ||
    targetMatches(target, request.decisionType)
  ) {
    return true;
  }
  return (
    request.action === request.decisionType &&
    isCanonicalAction(request.decisionType, target)
  );
}

function requirementSatisfied(
  constraint: Constraint,
  request: DecisionRequest,
): boolean {
  if (
    constraint.target === "runtime.approval" &&
    typeof constraint.value === "string"
  ) {
    // v0.2 has no persisted Approval record. Caller-provided context cannot
    // prove approval, so the constrained action must fail closed/escalate.
    return false;
  }
  const requirements = request.context?.requirements;
  if (Array.isArray(requirements) && requirements.includes(constraint.target)) {
    return true;
  }
  const actual = request.context?.[constraint.target];
  return constraint.value === undefined ? actual === true : actual === constraint.value;
}

function limitExceeded(
  constraint: Constraint,
  request: DecisionRequest,
): boolean {
  if (typeof constraint.value !== "number") return true;
  const actual = request.context?.[constraint.target];
  return typeof actual !== "number" || actual > constraint.value;
}

function violation(
  request: DecisionRequest,
  message: string,
  now: Date,
): DoctrineViolation {
  return {
    code: "CONSTRAINT_VIOLATION",
    actorId: request.actorId,
    decisionType: request.decisionType,
    message,
    createdAt: now,
  };
}
