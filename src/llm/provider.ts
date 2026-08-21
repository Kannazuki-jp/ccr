/**
 * @file ベンダーに依存しない構造化 LLM リクエストとプロバイダー契約を定義します。
 */

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
 * プロバイダーに依存しない構造化出力の境界です。
 * ベンダーアダプターは通信と SDK を担当してデコード済み JSON を返し、
 * 役割アダプターは役割別プロンプトとドメイン検証を担当します。
 */
export interface StructuredLlmProvider {
  generate(request: StructuredLlmRequest): Promise<unknown>;
}
