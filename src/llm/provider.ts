import { z } from "zod";

import type { AgentRole, JsonValue } from "../domain/index.js";

export const LlmOperationSchema = z.enum([
  "create-mission",
  "plan",
  "replan",
  "execute-task",
  "evaluate-task",
]);

export type LlmOperation = z.infer<typeof LlmOperationSchema>;

export interface StructuredLlmRequest {
  readonly role: AgentRole;
  readonly operation: LlmOperation;
  readonly system: string;
  readonly input: JsonValue;
  readonly schemaName: string;
  readonly outputSchema: JsonValue;
}

/**
 * Provider-neutral structured-output boundary. A vendor adapter owns network and
 * SDK concerns and returns decoded JSON; role adapters own role prompts and
 * domain validation.
 */
export interface StructuredLlmProvider {
  generate(request: StructuredLlmRequest): Promise<unknown>;
}
