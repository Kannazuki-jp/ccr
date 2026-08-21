import { z } from "zod";

import { DecisionTypeSchema } from "./decision-request.js";
import {
  NonEmptyTextSchema,
  TimestampSchema,
} from "./schemas.js";

export const DoctrineViolationCodeSchema = z.enum([
  "COMMAND_BOUNDARY_VIOLATION",
  "INSUFFICIENT_AUTHORITY",
  "CONSTRAINT_VIOLATION",
  "RISK_LIMIT_EXCEEDED",
  "INVALID_DELEGATION",
  "REVOKED_AUTHORITY",
  "EXPIRED_AUTHORITY",
  "EVALUATOR_STATE_MUTATION",
  "INVALID_STATE_TRANSITION",
]);

export const DoctrineViolationSchema = z
  .object({
    code: DoctrineViolationCodeSchema,
    actorId: NonEmptyTextSchema,
    decisionType: DecisionTypeSchema,
    message: NonEmptyTextSchema,
    createdAt: TimestampSchema,
  })
  .strict();

export const DoctrineViolationRecordSchema = DoctrineViolationSchema.extend({
  id: NonEmptyTextSchema,
  requestId: NonEmptyTextSchema,
  missionId: NonEmptyTextSchema,
  taskId: NonEmptyTextSchema.optional(),
}).strict();

export type DoctrineViolationCode = z.infer<
  typeof DoctrineViolationCodeSchema
>;
export type DoctrineViolation = z.infer<typeof DoctrineViolationSchema>;
export type DoctrineViolationRecord = z.infer<
  typeof DoctrineViolationRecordSchema
>;
