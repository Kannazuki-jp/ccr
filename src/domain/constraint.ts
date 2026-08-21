import { z } from "zod";

import { ResourceScopeSchema } from "./permission.js";
import {
  JsonValueSchema,
  NonEmptyTextSchema,
} from "./schemas.js";

export const ConstraintKindSchema = z.enum(["prohibit", "require", "limit"]);

export const ConstraintSchema = z
  .object({
    id: NonEmptyTextSchema,
    sourceId: NonEmptyTextSchema,
    kind: ConstraintKindSchema,
    target: NonEmptyTextSchema,
    scope: ResourceScopeSchema.optional(),
    value: JsonValueSchema.optional(),
    inherited: z.boolean(),
  })
  .strict();

export type ConstraintKind = z.infer<typeof ConstraintKindSchema>;
export type Constraint = z.infer<typeof ConstraintSchema>;
