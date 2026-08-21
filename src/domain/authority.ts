import { z } from "zod";

import { ConstraintSchema } from "./constraint.js";
import { PermissionSchema } from "./permission.js";
import { RiskLimitSchema } from "./risk-limit.js";
import {
  NonEmptyTextSchema,
  TimestampSchema,
} from "./schemas.js";

export const DecisionRightSchema = z.enum([
  "owner",
  "delegated",
  "propose",
  "verify",
  "enforce",
  "none",
]);

export const DoctrineActorRoleSchema = z.enum([
  "human",
  "commander",
  "lead",
  "worker",
  "evaluator",
  "runtime",
]);

export const StructuredAuthoritySchema = z
  .object({
    subjectId: NonEmptyTextSchema,
    permissions: z.array(PermissionSchema),
    constraints: z.array(ConstraintSchema),
    riskLimits: z.array(RiskLimitSchema),
  })
  .strict();

export const RoleAuthoritySchema = StructuredAuthoritySchema.extend({
  role: DoctrineActorRoleSchema,
}).strict();

export const AuthorityGrantStatusSchema = z.enum([
  "active",
  "revoked",
  "expired",
]);

export const AuthorityGrantSchema = z
  .object({
    id: NonEmptyTextSchema,
    issuerId: NonEmptyTextSchema,
    subjectId: NonEmptyTextSchema,
    missionId: NonEmptyTextSchema,
    taskId: NonEmptyTextSchema.optional(),
    permissions: z.array(PermissionSchema),
    constraints: z.array(ConstraintSchema),
    riskLimits: z.array(RiskLimitSchema),
    parentGrantIds: z.array(NonEmptyTextSchema).optional(),
    status: AuthorityGrantStatusSchema,
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema.optional(),
    revokedAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((grant, context) => {
    if (grant.expiresAt !== undefined && grant.expiresAt <= grant.createdAt) {
      context.addIssue({
        code: "custom",
        message: "expiresAt must be later than createdAt",
        path: ["expiresAt"],
      });
    }
    if (grant.status === "revoked" && grant.revokedAt === undefined) {
      context.addIssue({
        code: "custom",
        message: "a revoked grant must include revokedAt",
        path: ["revokedAt"],
      });
    }
    if (grant.status !== "revoked" && grant.revokedAt !== undefined) {
      context.addIssue({
        code: "custom",
        message: "only a revoked grant may include revokedAt",
        path: ["revokedAt"],
      });
    }
    if (
      grant.revokedAt !== undefined &&
      grant.revokedAt < grant.createdAt
    ) {
      context.addIssue({
        code: "custom",
        message: "revokedAt must not precede createdAt",
        path: ["revokedAt"],
      });
    }
    if (grant.status === "expired" && grant.expiresAt === undefined) {
      context.addIssue({
        code: "custom",
        message: "an expired grant must include expiresAt",
        path: ["expiresAt"],
      });
    }
  });

export const AuthorityContextSchema = z
  .object({
    missionId: NonEmptyTextSchema,
    taskId: NonEmptyTextSchema.optional(),
    role: DoctrineActorRoleSchema,
    currentConstraints: z.array(ConstraintSchema).optional(),
    currentRiskLimits: z.array(RiskLimitSchema).optional(),
    at: TimestampSchema.optional(),
  })
  .strict();

export const EffectiveAuthoritySchema = StructuredAuthoritySchema.extend({
  missionId: NonEmptyTextSchema,
  taskId: NonEmptyTextSchema.optional(),
  grantIds: z.array(NonEmptyTextSchema),
}).strict();

export const DelegationRequestSchema = z
  .object({
    issuerId: NonEmptyTextSchema,
    subjectId: NonEmptyTextSchema,
    missionId: NonEmptyTextSchema,
    taskId: NonEmptyTextSchema.optional(),
    permissions: z.array(PermissionSchema),
    constraints: z.array(ConstraintSchema),
    riskLimits: z.array(RiskLimitSchema),
    expiresAt: TimestampSchema.optional(),
  })
  .strict();

export const RevocationRequestSchema = z
  .object({
    actorId: NonEmptyTextSchema,
    grantId: NonEmptyTextSchema,
    reason: NonEmptyTextSchema,
  })
  .strict();

export type DecisionRight = z.infer<typeof DecisionRightSchema>;
export type DoctrineActorRole = z.infer<typeof DoctrineActorRoleSchema>;
export type StructuredAuthority = z.infer<typeof StructuredAuthoritySchema>;
export type RoleAuthority = z.infer<typeof RoleAuthoritySchema>;
export type AuthorityGrantStatus = z.infer<typeof AuthorityGrantStatusSchema>;
export type AuthorityGrant = z.infer<typeof AuthorityGrantSchema>;
export type AuthorityContext = z.infer<typeof AuthorityContextSchema>;
export type EffectiveAuthority = z.infer<typeof EffectiveAuthoritySchema>;
export type DelegationRequest = z.infer<typeof DelegationRequestSchema>;
export type RevocationRequest = z.infer<typeof RevocationRequestSchema>;
