import { z } from "zod";

import { AuthorityGrantSchema } from "./authority.js";
import { DoctrineActorRoleSchema } from "./authority.js";
import { DecisionTypeSchema } from "./decision-request.js";
import {
  DoctrineViolationRecordSchema,
  DoctrineViolationSchema,
} from "./doctrine-violation.js";
import {
  EscalationRecordSchema,
  EscalationRequestSchema,
} from "./escalation.js";
import {
  NonEmptyTextSchema,
  TimestampSchema,
} from "./schemas.js";

export const AuthorizationResultSchema = z.discriminatedUnion("result", [
  z
    .object({
      result: z.literal("allow"),
      reason: NonEmptyTextSchema,
    })
    .strict(),
  z
    .object({
      result: z.literal("deny"),
      reason: NonEmptyTextSchema,
      violation: DoctrineViolationSchema,
    })
    .strict(),
  z
    .object({
      result: z.literal("escalate"),
      reason: NonEmptyTextSchema,
      escalation: EscalationRequestSchema,
    })
    .strict(),
]);

export const AuthorizationRecordSchema = z
  .object({
    id: NonEmptyTextSchema,
    requestId: NonEmptyTextSchema,
    missionId: NonEmptyTextSchema,
    taskId: NonEmptyTextSchema.optional(),
    actorId: NonEmptyTextSchema,
    decisionType: DecisionTypeSchema,
    result: z.enum(["allow", "deny", "escalate"]),
    reason: NonEmptyTextSchema,
    targetRole: DoctrineActorRoleSchema.optional(),
    violation: DoctrineViolationRecordSchema.optional(),
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.result === "deny" && record.violation === undefined) {
      context.addIssue({
        code: "custom",
        message: "a denied authorization must include its violation",
        path: ["violation"],
      });
    }
    if (record.result !== "deny" && record.violation !== undefined) {
      context.addIssue({
        code: "custom",
        message: "only a denied authorization may include a violation",
        path: ["violation"],
      });
    }
    if (record.result === "escalate" && record.targetRole === undefined) {
      context.addIssue({
        code: "custom",
        message: "an escalated authorization must include targetRole",
        path: ["targetRole"],
      });
    }
    if (record.result !== "escalate" && record.targetRole !== undefined) {
      context.addIssue({
        code: "custom",
        message: "only an escalated authorization may include targetRole",
        path: ["targetRole"],
      });
    }
  });

export const DelegationResultSchema = z.discriminatedUnion("result", [
  z
    .object({
      result: z.literal("allow"),
      reason: NonEmptyTextSchema,
      grant: AuthorityGrantSchema,
    })
    .strict(),
  z
    .object({
      result: z.literal("deny"),
      reason: NonEmptyTextSchema,
      violation: DoctrineViolationSchema,
    })
    .strict(),
]);

export const RevocationResultSchema = DelegationResultSchema;

export const EscalationResultSchema = z.discriminatedUnion("result", [
  z
    .object({
      result: z.literal("escalate"),
      reason: NonEmptyTextSchema,
      escalation: EscalationRecordSchema,
    })
    .strict(),
  z
    .object({
      result: z.literal("deny"),
      reason: NonEmptyTextSchema,
      violation: DoctrineViolationSchema,
    })
    .strict(),
]);

export const EscalationResolutionResultSchema = z.discriminatedUnion(
  "result",
  [
    z
      .object({
        result: z.literal("allow"),
        reason: NonEmptyTextSchema,
        escalation: EscalationRecordSchema,
      })
      .strict(),
    z
      .object({
        result: z.literal("deny"),
        reason: NonEmptyTextSchema,
        violation: DoctrineViolationSchema,
      })
      .strict(),
  ],
);

export type AuthorizationResult = z.infer<typeof AuthorizationResultSchema>;
export type AuthorizationRecord = z.infer<typeof AuthorizationRecordSchema>;
export type DelegationResult = z.infer<typeof DelegationResultSchema>;
export type RevocationResult = z.infer<typeof RevocationResultSchema>;
export type EscalationResult = z.infer<typeof EscalationResultSchema>;
export type EscalationResolutionResult = z.infer<
  typeof EscalationResolutionResultSchema
>;
