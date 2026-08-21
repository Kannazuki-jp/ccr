import { z } from "zod";

import { DoctrineActorRoleSchema } from "./authority.js";
import {
  JsonValueSchema,
  NonEmptyTextSchema,
  TimestampSchema,
} from "./schemas.js";
import { ResourceScopeSchema } from "./permission.js";

export const DecisionTypeSchema = z.enum([
  "goal.create",
  "goal.modify",
  "strategic_constraint.modify",
  "mission.create",
  "mission.purpose.modify",
  "mission.intent.modify",
  "mission.end_state.modify",
  "mission.priority.modify",
  "mission.constraint.modify",
  "mission.success_criteria.modify",
  "mission.scope.modify",
  "mission.cancel",
  "task.create",
  "task.modify",
  "task.remove",
  "task.assign",
  "task.reorder",
  "task.constraint.modify",
  "task.success_criteria.modify",
  "plan.modify",
  "authority.delegate",
  "execution.method.select",
  "execution.tool.select",
  "execution.local_change",
  "execution.retry",
  "execution.procedure.modify",
  "report.submit",
  "evaluation.verify",
  "evaluation.pass",
  "evaluation.fail",
  "evaluation.recommend",
  "state.transition",
  "authority.revoke",
]);

export const DecisionRequestContextSchema = z.record(
  z.string(),
  JsonValueSchema,
);

export const DecisionRequestSchema = z
  .object({
    id: NonEmptyTextSchema,
    actorId: NonEmptyTextSchema,
    role: DoctrineActorRoleSchema,
    missionId: NonEmptyTextSchema,
    taskId: NonEmptyTextSchema.optional(),
    decisionType: DecisionTypeSchema,
    action: NonEmptyTextSchema,
    resource: ResourceScopeSchema.optional(),
    context: DecisionRequestContextSchema.optional(),
    createdAt: TimestampSchema,
  })
  .strict();

export type DecisionType = z.infer<typeof DecisionTypeSchema>;
export type DecisionRequestContext = z.infer<
  typeof DecisionRequestContextSchema
>;
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;
