import type {
  DecisionRight,
  DecisionType,
  DoctrineActorRole,
} from "../../domain/index.js";

export const commandBoundaries = {
  "goal.create": "human",
  "goal.modify": "human",
  "strategic_constraint.modify": "human",
  "mission.create": "commander",
  "mission.purpose.modify": "commander",
  "mission.intent.modify": "commander",
  "mission.end_state.modify": "commander",
  "mission.priority.modify": "commander",
  "mission.constraint.modify": "commander",
  "mission.success_criteria.modify": "commander",
  "mission.scope.modify": "commander",
  "mission.cancel": "human",
  "task.create": "lead",
  "task.modify": "lead",
  "task.remove": "lead",
  "task.assign": "lead",
  "task.reorder": "lead",
  "task.constraint.modify": "lead",
  "task.success_criteria.modify": "lead",
  "plan.modify": "lead",
  "authority.delegate": "lead",
  "execution.method.select": "worker",
  "execution.tool.select": "worker",
  "execution.local_change": "worker",
  "execution.retry": "worker",
  "execution.procedure.modify": "worker",
  "report.submit": "worker",
  "evaluation.verify": "evaluator",
  "evaluation.pass": "evaluator",
  "evaluation.fail": "evaluator",
  "evaluation.recommend": "evaluator",
  "state.transition": "runtime",
  "authority.revoke": "runtime",
} as const satisfies Record<DecisionType, DoctrineActorRole>;

export function getDecisionOwner(
  decisionType: DecisionType,
): DoctrineActorRole {
  return commandBoundaries[decisionType];
}

export function getDecisionRight(
  role: DoctrineActorRole,
  decisionType: DecisionType,
): DecisionRight {
  if (role === "evaluator" && decisionType.startsWith("evaluation.")) {
    return "verify";
  }
  if (role === "runtime" &&
      (decisionType === "state.transition" || decisionType === "authority.revoke")) {
    return "enforce";
  }
  const owner = getDecisionOwner(decisionType);
  if (role === owner) return "owner";

  if (
    (role === "human" &&
      decisionType === "mission.create") ||
    (role === "commander" && decisionType === "mission.cancel") ||
    (role === "commander" &&
      (decisionType.startsWith("task.") ||
        decisionType === "authority.delegate")) ||
    (role === "lead" &&
      [
        "execution.tool.select",
        "execution.local_change",
        "execution.retry",
        "execution.procedure.modify",
      ].includes(decisionType)) ||
    (role === "worker" && decisionType === "task.reorder")
  ) {
    return "delegated";
  }

  if (
    (role === "commander" &&
      (decisionType.startsWith("goal.") ||
        decisionType === "strategic_constraint.modify")) ||
    (role === "lead" &&
      (decisionType.startsWith("mission.") ||
        decisionType === "goal.modify")) ||
    (role === "worker" &&
      (decisionType.startsWith("task.") || decisionType === "plan.modify"))
  ) {
    return "propose";
  }

  return "none";
}

export function isNonTransferableCommandDecision(
  decisionType: DecisionType,
): boolean {
  return (
    decisionType.startsWith("goal.") ||
    decisionType === "strategic_constraint.modify" ||
    decisionType.startsWith("mission.")
  );
}
