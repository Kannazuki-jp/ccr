import { z } from "zod";

import { DoctrineActorRoleSchema } from "./authority.js";
import { DecisionTypeSchema } from "./decision-request.js";
import {
  JsonValueSchema,
  NonEmptyTextSchema,
  TimestampSchema,
} from "./schemas.js";

export const EscalationRequestSchema = z
  .object({
    id: NonEmptyTextSchema,
    missionId: NonEmptyTextSchema,
    taskId: NonEmptyTextSchema.optional(),
    requesterId: NonEmptyTextSchema,
    decisionType: DecisionTypeSchema,
    reason: NonEmptyTextSchema,
    requestedChange: JsonValueSchema.optional(),
    targetRole: DoctrineActorRoleSchema,
    createdAt: TimestampSchema,
  })
  .strict();

export const EscalationStatusSchema = z.enum(["open", "resolved"]);

export const EscalationResolutionRequestSchema = z
  .object({
    id: NonEmptyTextSchema,
    escalationId: NonEmptyTextSchema,
    actorId: NonEmptyTextSchema,
    reason: NonEmptyTextSchema,
    createdAt: TimestampSchema,
  })
  .strict();

export const EscalationRecordSchema = EscalationRequestSchema.extend({
  status: EscalationStatusSchema,
  resolvedAt: TimestampSchema.optional(),
})
  .strict()
  .superRefine((escalation, context) => {
    if (escalation.status === "resolved" && escalation.resolvedAt === undefined) {
      context.addIssue({
        code: "custom",
        message: "a resolved escalation must include resolvedAt",
        path: ["resolvedAt"],
      });
    }
    if (escalation.status === "open" && escalation.resolvedAt !== undefined) {
      context.addIssue({
        code: "custom",
        message: "an open escalation must not include resolvedAt",
        path: ["resolvedAt"],
      });
    }
    if (
      escalation.resolvedAt !== undefined &&
      escalation.resolvedAt < escalation.createdAt
    ) {
      context.addIssue({
        code: "custom",
        message: "resolvedAt must not precede createdAt",
        path: ["resolvedAt"],
      });
    }
  });

export type EscalationRequest = z.infer<typeof EscalationRequestSchema>;
export type EscalationResolutionRequest = z.infer<
  typeof EscalationResolutionRequestSchema
>;
export type EscalationStatus = z.infer<typeof EscalationStatusSchema>;
export type EscalationRecord = z.infer<typeof EscalationRecordSchema>;
