import type {
  DecisionRequest,
  DoctrineViolation,
  RiskLimit,
} from "../../domain/index.js";

export function findRiskLimitViolation(
  request: DecisionRequest,
  limits: readonly RiskLimit[],
  now: Date,
): DoctrineViolation | undefined {
  const risk = request.context?.risk;
  if (typeof risk !== "object" || risk === null || Array.isArray(risk)) {
    return limits.length === 0
      ? undefined
      : violation(
          request,
          `Risk measurement ${limits[0]!.dimension} is required`,
          now,
        );
  }

  for (const limit of limits) {
    const value = risk[limit.dimension];
    if (typeof value !== "number") {
      return violation(
        request,
        `Risk measurement ${limit.dimension} is required`,
        now,
      );
    }
    const allowed =
      limit.operator === "lt"
        ? value < limit.value
        : limit.operator === "lte"
          ? value <= limit.value
          : value === limit.value;
    if (!allowed) {
      return violation(
        request,
        `Risk ${limit.dimension}=${String(value)} violates ${limit.operator} ${String(limit.value)}`,
        now,
      );
    }
  }
  return undefined;
}

function violation(
  request: DecisionRequest,
  message: string,
  now: Date,
): DoctrineViolation {
  return {
    code: "RISK_LIMIT_EXCEEDED",
    actorId: request.actorId,
    decisionType: request.decisionType,
    message,
    createdAt: now,
  };
}

export function riskLimitIsAtLeastAsStrict(
  child: RiskLimit,
  parent: RiskLimit,
): boolean {
  if (child.dimension !== parent.dimension) return false;
  if (parent.operator === "eq") {
    return child.operator === "eq" && child.value === parent.value;
  }
  if (child.operator === "eq") {
    return parent.operator === "lt"
      ? child.value < parent.value
      : child.value <= parent.value;
  }
  if (parent.operator === "lte") {
    return child.value <= parent.value;
  }
  return child.value < parent.value ||
    (child.value === parent.value && child.operator === "lt");
}
