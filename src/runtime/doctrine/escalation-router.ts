import type {
  DecisionType,
  DoctrineActorRole,
} from "../../domain/index.js";

import { getDecisionOwner } from "./boundary-registry.js";

export function routeEscalation(
  _requesterRole: DoctrineActorRole,
  decisionType: DecisionType,
): DoctrineActorRole {
  return getDecisionOwner(decisionType);
}

const COMMAND_LEVEL: Partial<Record<DoctrineActorRole, number>> = {
  human: 0,
  commander: 1,
  lead: 2,
  worker: 3,
};

export function isValidEscalationRoute(
  requesterRole: DoctrineActorRole,
  targetRole: DoctrineActorRole,
): boolean {
  if (requesterRole === "evaluator") {
    return targetRole === "human" || targetRole === "commander" || targetRole === "lead";
  }
  const requesterLevel = COMMAND_LEVEL[requesterRole];
  const targetLevel = COMMAND_LEVEL[targetRole];
  return requesterLevel !== undefined && targetLevel !== undefined && targetLevel < requesterLevel;
}
