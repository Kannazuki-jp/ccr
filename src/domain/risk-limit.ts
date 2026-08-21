import { z } from "zod";

import { NonEmptyTextSchema } from "./schemas.js";

export const RiskLimitOperatorSchema = z.enum(["lt", "lte", "eq"]);

export const RiskLimitSchema = z
  .object({
    dimension: NonEmptyTextSchema,
    operator: RiskLimitOperatorSchema,
    value: z.number().finite(),
  })
  .strict();

export type RiskLimitOperator = z.infer<typeof RiskLimitOperatorSchema>;
export type RiskLimit = z.infer<typeof RiskLimitSchema>;
