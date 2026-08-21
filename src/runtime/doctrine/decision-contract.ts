import type {
  DecisionRequest,
  DecisionType,
  ResourceScope,
} from "../../domain/index.js";

const canonicalActions = {
  "goal.create": ["goal.create", "create"],
  "goal.modify": ["goal.modify", "modify"],
  "strategic_constraint.modify": ["strategic_constraint.modify", "modify"],
  "mission.create": ["mission.create", "create"],
  "mission.purpose.modify": ["mission.purpose.modify", "modify"],
  "mission.intent.modify": ["mission.intent.modify", "modify"],
  "mission.end_state.modify": ["mission.end_state.modify", "modify"],
  "mission.priority.modify": ["mission.priority.modify", "modify"],
  "mission.constraint.modify": ["mission.constraint.modify", "modify"],
  "mission.success_criteria.modify": ["mission.success_criteria.modify", "modify"],
  "mission.scope.modify": ["mission.scope.modify", "modify"],
  "mission.cancel": ["mission.cancel", "cancel"],
  "task.create": ["task.create", "create"],
  "task.modify": ["task.modify", "modify"],
  "task.remove": ["task.remove", "remove"],
  "task.assign": ["task.assign", "assign"],
  "task.reorder": ["task.reorder", "reorder"],
  "task.constraint.modify": ["task.constraint.modify", "modify"],
  "task.success_criteria.modify": ["task.success_criteria.modify", "modify"],
  "plan.modify": ["plan.modify", "modify"],
  "authority.delegate": ["authority.delegate", "delegate"],
  "execution.method.select": ["execution.method.select", "select"],
  "execution.tool.select": ["execution.tool.select", "select", "tool.select"],
  "execution.local_change": [
    "execution.local_change",
    "code.read",
    "code.edit",
    "public_api.modify",
  ],
  "execution.retry": ["execution.retry", "retry"],
  "execution.procedure.modify": ["execution.procedure.modify", "modify", "test.run"],
  "report.submit": ["report.submit", "submit"],
  "evaluation.verify": ["evaluation.verify", "verify"],
  "evaluation.pass": ["evaluation.pass", "pass"],
  "evaluation.fail": ["evaluation.fail", "fail"],
  "evaluation.recommend": ["evaluation.recommend", "recommend"],
  "state.transition": ["state.transition", "transition"],
  "authority.revoke": ["authority.revoke", "revoke"],
} as const satisfies Record<DecisionType, readonly string[]>;

const SCOPED_DECISIONS = new Set<DecisionType>([
  "execution.method.select",
  "execution.tool.select",
  "execution.local_change",
  "execution.retry",
  "execution.procedure.modify",
  "report.submit",
]);

export function isCanonicalAction(
  decisionType: DecisionType,
  action: string,
): boolean {
  return (canonicalActions[decisionType] as readonly string[]).includes(action);
}

export function decisionRequiresResource(decisionType: DecisionType): boolean {
  return SCOPED_DECISIONS.has(decisionType);
}

export function getCanonicalActions(
  decisionType: DecisionType,
): readonly string[] {
  return canonicalActions[decisionType];
}

export function resolvePermissionAction(
  decisionType: DecisionType,
  action: string,
): string | undefined {
  if (!isCanonicalAction(decisionType, action)) return undefined;
  if (
    action === "code.read" ||
    action === "code.edit" ||
    action === "public_api.modify" ||
    action === "tool.select" ||
    action === "test.run"
  ) {
    return action;
  }
  return decisionType;
}

export function decisionBoundaryResource(
  request: Pick<
    DecisionRequest,
    "decisionType" | "missionId" | "taskId" | "context"
  >,
  missionExists: boolean,
): ResourceScope | undefined {
  const { decisionType } = request;
  if (
    decisionType.startsWith("goal.") ||
    decisionType === "strategic_constraint.modify"
  ) {
    return { type: "global" };
  }
  if (decisionType === "mission.create" && !missionExists) {
    return { type: "global" };
  }
  if (decisionType.startsWith("mission.") || decisionType === "plan.modify") {
    return { type: "mission", missionId: request.missionId };
  }
  if (
    decisionType.startsWith("task.") ||
    decisionType.startsWith("execution.") ||
    decisionType.startsWith("evaluation.") ||
    decisionType === "report.submit"
  ) {
    return request.taskId === undefined
      ? undefined
      : { type: "task", taskId: request.taskId };
  }
  if (decisionType === "state.transition") {
    return request.context?.entity === "task"
      ? request.taskId === undefined
        ? undefined
        : { type: "task", taskId: request.taskId }
      : request.context?.entity === "mission"
        ? { type: "mission", missionId: request.missionId }
        : undefined;
  }
  if (
    decisionType === "authority.delegate" ||
    decisionType === "authority.revoke"
  ) {
    return request.taskId === undefined
      ? { type: "mission", missionId: request.missionId }
      : { type: "task", taskId: request.taskId };
  }
  return undefined;
}

export function resourceMatchesDecisionBoundary(
  request: DecisionRequest,
  expected: ResourceScope | undefined,
): boolean {
  if (expected === undefined || request.resource === undefined) return false;
  // Concrete execution capabilities keep their explicit path/tool/task scope.
  if (
    request.decisionType.startsWith("execution.") &&
    request.action !== request.decisionType
  ) {
    return true;
  }
  if (request.resource.type !== expected.type) return false;
  if (expected.type === "global") return true;
  if (expected.type === "mission") {
    return (
      request.resource.type === "mission" &&
      request.resource.missionId === expected.missionId
    );
  }
  if (expected.type === "task") {
    return (
      request.resource.type === "task" &&
      request.resource.taskId === expected.taskId
    );
  }
  return false;
}

export function decisionUsesTaskRisk(
  request: Pick<DecisionRequest, "decisionType" | "context">,
): boolean {
  return (
    request.decisionType.startsWith("task.") ||
    request.decisionType.startsWith("execution.") ||
    request.decisionType.startsWith("evaluation.") ||
    request.decisionType === "report.submit" ||
    (request.decisionType === "state.transition" &&
      request.context?.entity === "task")
  );
}
