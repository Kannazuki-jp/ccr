/**
 * @file Controlled Repository Execution v0.3 の ToolRequest / ToolEvidence 契約です。
 *
 * Agent は ToolRequestProposal だけを提出します。identity、順序、時刻、Evidence は
 * Runtime または ToolBroker が付与するため、この module の schema はその境界を
 * 意図的に分離します。
 */

import { z } from "zod";

import { ResourceScopeSchema } from "./permission.js";
import {
  IdentifierSchema,
  NonEmptyTextSchema,
  TimestampSchema,
} from "./schemas.js";

const MAX_TOOL_TEXT_LENGTH = 32_768;
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i, "must be a SHA-256 hex digest");

/** A canonical, workspace-relative POSIX path. `.` denotes the workspace root. */
export const RelativeRepositoryPathSchema = z.string().superRefine((value, context) => {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..") &&
      value !== "."
  ) {
    context.addIssue({
      code: "custom",
      message: "path must be a canonical workspace-relative POSIX path",
    });
  }
});

const ToolTextSchema = z.string().max(MAX_TOOL_TEXT_LENGTH);
const ToolSummarySchema = NonEmptyTextSchema.max(MAX_TOOL_TEXT_LENGTH);
const PositiveIntegerSchema = z.number().int().positive();
const NonNegativeIntegerSchema = z.number().int().nonnegative();

export const ToolNameSchema = z.enum([
  "repo.list",
  "repo.search",
  "repo.read",
  "repo.patch",
  "test.run",
]);

/** Concrete Doctrine permission actions derived from a built-in tool. */
export const ToolActionSchema = z.enum(["code.read", "code.edit", "test.run"]);

export const toolActionByName = {
  "repo.list": "code.read",
  "repo.search": "code.read",
  "repo.read": "code.read",
  "repo.patch": "code.edit",
  "test.run": "test.run",
} as const satisfies Record<z.infer<typeof ToolNameSchema>, z.infer<typeof ToolActionSchema>>;

export function toolActionFor(tool: ToolName): ToolAction {
  return toolActionByName[tool];
}

export const RepoListInputSchema = z.object({
  path: RelativeRepositoryPathSchema,
  maxDepth: z.number().int().min(0).max(8),
}).strict();

export const RepoSearchInputSchema = z.object({
  query: NonEmptyTextSchema.max(1_024),
  paths: z.array(RelativeRepositoryPathSchema).min(1).max(128).superRefine((paths, context) => {
    if (new Set(paths).size !== paths.length) {
      context.addIssue({ code: "custom", message: "search paths must be unique" });
    }
  }),
  maxResults: PositiveIntegerSchema.max(1_000),
}).strict();

export const RepoReadInputSchema = z.object({
  path: RelativeRepositoryPathSchema,
  offset: NonNegativeIntegerSchema,
  limit: PositiveIntegerSchema.max(1_048_576),
}).strict();

export const RepoPatchInputSchema = z.object({
  path: RelativeRepositoryPathSchema,
  operation: z.enum(["create", "update", "delete"]),
  content: ToolTextSchema.optional(),
  expectedSha256: Sha256Schema.optional(),
}).strict().superRefine((input, context) => {
  const needsContent = input.operation === "create" || input.operation === "update";
  const needsHash = input.operation === "update" || input.operation === "delete";
  if (needsContent && input.content === undefined) {
    context.addIssue({ code: "custom", message: "create and update require content", path: ["content"] });
  }
  if (!needsContent && input.content !== undefined) {
    context.addIssue({ code: "custom", message: "delete cannot include content", path: ["content"] });
  }
  if (needsHash && input.expectedSha256 === undefined) {
    context.addIssue({ code: "custom", message: "update and delete require expectedSha256", path: ["expectedSha256"] });
  }
  if (!needsHash && input.expectedSha256 !== undefined) {
    context.addIssue({ code: "custom", message: "create cannot include expectedSha256", path: ["expectedSha256"] });
  }
});

export const TestRunInputSchema = z.object({
  commandId: NonEmptyTextSchema.max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "commandId must be a policy key"),
}).strict();

export const ToolInputSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("repo.list"), input: RepoListInputSchema }).strict(),
  z.object({ tool: z.literal("repo.search"), input: RepoSearchInputSchema }).strict(),
  z.object({ tool: z.literal("repo.read"), input: RepoReadInputSchema }).strict(),
  z.object({ tool: z.literal("repo.patch"), input: RepoPatchInputSchema }).strict(),
  z.object({ tool: z.literal("test.run"), input: TestRunInputSchema }).strict(),
]);

/** The only tool-shaped object accepted from a Worker. */
export const ToolRequestProposalSchema = ToolInputSchema;

const ToolRequestBaseSchema = z.object({
  id: IdentifierSchema,
  missionId: IdentifierSchema,
  taskId: IdentifierSchema,
  actorId: NonEmptyTextSchema,
  attempt: PositiveIntegerSchema,
  sequence: PositiveIntegerSchema,
  requestedAt: TimestampSchema,
});

/** A Runtime-bound, appendable request. It never accepts agent-supplied identity fields. */
export const ToolRequestSchema = z.discriminatedUnion("tool", [
  ToolRequestBaseSchema.extend({ tool: z.literal("repo.list"), input: RepoListInputSchema }).strict(),
  ToolRequestBaseSchema.extend({ tool: z.literal("repo.search"), input: RepoSearchInputSchema }).strict(),
  ToolRequestBaseSchema.extend({ tool: z.literal("repo.read"), input: RepoReadInputSchema }).strict(),
  ToolRequestBaseSchema.extend({ tool: z.literal("repo.patch"), input: RepoPatchInputSchema }).strict(),
  ToolRequestBaseSchema.extend({ tool: z.literal("test.run"), input: TestRunInputSchema }).strict(),
]);

/** Trusted values that Runtime binds to an agent proposal before persistence. */
export const RuntimeToolRequestBindingSchema = ToolRequestBaseSchema.strict();

/**
 * Validates an untrusted Worker proposal and combines it with Runtime-owned fields.
 * In particular, this API has no way to preserve a worker-provided ID, actor, order,
 * attempt, or timestamp.
 */
export function bindToolRequest(
  proposal: unknown,
  runtimeBinding: unknown,
): ToolRequest {
  const parsedProposal = parseToolRequestProposal(proposal);
  const binding = RuntimeToolRequestBindingSchema.safeParse(runtimeBinding);
  if (!binding.success) {
    throw new InvalidToolRequestError("Runtime tool request binding is invalid");
  }
  return ToolRequestSchema.parse({ ...binding.data, ...parsedProposal });
}

/** Operation authorization and normalized resource at the same index form one concrete permit. */
export const ToolAuthorizationBundleSchema = z.object({
  selectionAuthorizationId: IdentifierSchema,
  operationAuthorizationIds: z.tuple([IdentifierSchema]).rest(IdentifierSchema).superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "operation authorization IDs must be unique" });
    }
  }),
  normalizedResources: z.array(ResourceScopeSchema).min(1),
  digest: Sha256Schema,
}).strict().superRefine((bundle, context) => {
  if (bundle.operationAuthorizationIds.includes(bundle.selectionAuthorizationId)) {
    context.addIssue({
      code: "custom",
      message: "selection authorization must be independent from operation authorizations",
      path: ["operationAuthorizationIds"],
    });
  }
  if (bundle.operationAuthorizationIds.length !== bundle.normalizedResources.length) {
    context.addIssue({
      code: "custom",
      message: "each operation authorization must have one normalized resource",
      path: ["normalizedResources"],
    });
  }
});

export const ToolSideEffectSchema = z.object({
  path: RelativeRepositoryPathSchema,
  operation: z.enum(["create", "update", "delete"]),
  beforeSha256: Sha256Schema.nullable(),
  afterSha256: Sha256Schema.nullable(),
  applied: z.boolean(),
}).strict();

const OutputCaptureSchema = z.object({
  summary: ToolSummarySchema,
  sha256: Sha256Schema,
  bytes: NonNegativeIntegerSchema,
}).strict();

const RepoListObservationSchema = z.object({
  entries: z.array(z.object({
    path: RelativeRepositoryPathSchema,
    kind: z.enum(["file", "directory", "symlink"]),
    size: NonNegativeIntegerSchema,
  }).strict()),
}).strict();

const RepoSearchObservationSchema = z.object({
  matches: z.array(z.object({
    path: RelativeRepositoryPathSchema,
    line: PositiveIntegerSchema,
    column: PositiveIntegerSchema,
    excerpt: ToolSummarySchema,
  }).strict()),
  scannedFileCount: NonNegativeIntegerSchema,
}).strict();

const RepoReadObservationSchema = z.object({
  offset: NonNegativeIntegerSchema,
  bytesRead: NonNegativeIntegerSchema,
  totalBytes: NonNegativeIntegerSchema,
  content: ToolTextSchema,
  contentSha256: Sha256Schema,
}).strict();

const RepoPatchObservationSchema = z.object({
  operation: z.enum(["create", "update", "delete"]),
  beforeSha256: Sha256Schema.nullable(),
  afterSha256: Sha256Schema.nullable(),
  bytes: NonNegativeIntegerSchema,
}).strict();

const TestRunObservationSchema = z.object({
  commandId: NonEmptyTextSchema.max(128),
  exitCode: z.number().int().nullable(),
  signal: NonEmptyTextSchema.max(128).nullable(),
  stdout: OutputCaptureSchema,
  stderr: OutputCaptureSchema,
}).strict();

const ToolEvidenceBaseSchema = z.object({
  id: IdentifierSchema,
  requestId: IdentifierSchema,
  authorization: ToolAuthorizationBundleSchema,
  missionId: IdentifierSchema,
  taskId: IdentifierSchema,
  actorId: NonEmptyTextSchema,
  attempt: PositiveIntegerSchema,
  sequence: PositiveIntegerSchema,
  tool: ToolNameSchema,
  sideEffects: z.array(ToolSideEffectSchema),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
  durationMs: NonNegativeIntegerSchema,
  outputSha256: Sha256Schema,
  truncated: z.boolean(),
});

const ToolErrorSchema = z.object({
  code: NonEmptyTextSchema.max(128),
  message: ToolSummarySchema,
}).strict();

const EvidenceVariant = <
  TTool extends ToolName,
  TObservation extends z.ZodObject<z.ZodRawShape>,
>(tool: TTool, observation: TObservation) => [
  ToolEvidenceBaseSchema.extend({ tool: z.literal(tool), status: z.literal("succeeded"), observation }).strict(),
  ToolEvidenceBaseSchema.extend({ tool: z.literal(tool), status: z.enum(["failed", "timed_out"]), observation: observation.partial().optional(), error: ToolErrorSchema }).strict(),
] as const;

const evidenceVariants = [
  ...EvidenceVariant("repo.list", RepoListObservationSchema),
  ...EvidenceVariant("repo.search", RepoSearchObservationSchema),
  ...EvidenceVariant("repo.read", RepoReadObservationSchema),
  ...EvidenceVariant("repo.patch", RepoPatchObservationSchema),
  ...EvidenceVariant("test.run", TestRunObservationSchema),
] as const;

/** Runtime-normalized observation of an execution that reached the ToolBroker. */
export const ToolEvidenceSchema = z.union(evidenceVariants).superRefine((evidence, context) => {
  if (evidence.finishedAt < evidence.startedAt) {
    context.addIssue({ code: "custom", message: "finishedAt must not precede startedAt", path: ["finishedAt"] });
  }
  if (evidence.durationMs !== evidence.finishedAt.getTime() - evidence.startedAt.getTime()) {
    context.addIssue({ code: "custom", message: "durationMs must match the timestamps", path: ["durationMs"] });
  }
  if (evidence.tool !== "repo.patch" && evidence.sideEffects.length > 0) {
    context.addIssue({ code: "custom", message: "read-only tools cannot have side effects", path: ["sideEffects"] });
  }
  if (evidence.status === "succeeded" && evidence.tool === "repo.patch") {
    if (!evidence.sideEffects.some((effect) => effect.applied)) {
      context.addIssue({ code: "custom", message: "a successful patch requires an applied side effect", path: ["sideEffects"] });
    }
  }
  if (evidence.status === "succeeded" && evidence.tool === "test.run" && evidence.observation.exitCode !== 0) {
    context.addIssue({ code: "custom", message: "a successful test.run requires exitCode 0", path: ["observation", "exitCode"] });
  }
});

export class InvalidToolRequestError extends Error {
  public constructor(message: string) { super(message); this.name = "InvalidToolRequestError"; }
}

export class UnsupportedToolError extends InvalidToolRequestError {
  public constructor(tool: unknown) { super(`Unsupported tool: ${String(tool)}`); this.name = "UnsupportedToolError"; }
}

export class InvalidToolInputError extends InvalidToolRequestError {
  public constructor(message: string) { super(message); this.name = "InvalidToolInputError"; }
}

/** Reserved for the subsequent ToolBroker package, keeping schema and execution failures distinct. */
export class ToolExecutionError extends Error {
  public constructor(message: string) { super(message); this.name = "ToolExecutionError"; }
}

/** Parses worker-controlled data without accepting Runtime-owned request fields. */
export function parseToolRequestProposal(input: unknown): ToolRequestProposal {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InvalidToolRequestError("Tool request proposal must be an object");
  }
  const tool = "tool" in input ? input.tool : undefined;
  if (typeof tool === "string" && !ToolNameSchema.options.includes(tool as ToolName)) {
    throw new UnsupportedToolError(tool);
  }
  const parsed = ToolRequestProposalSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidToolInputError("Tool request proposal does not match the selected tool input contract");
  }
  return parsed.data;
}

export type ToolName = z.infer<typeof ToolNameSchema>;
export type ToolAction = z.infer<typeof ToolActionSchema>;
export type RepoListInput = z.infer<typeof RepoListInputSchema>;
export type RepoSearchInput = z.infer<typeof RepoSearchInputSchema>;
export type RepoReadInput = z.infer<typeof RepoReadInputSchema>;
export type RepoPatchInput = z.infer<typeof RepoPatchInputSchema>;
export type TestRunInput = z.infer<typeof TestRunInputSchema>;
export type ToolRequestProposal = z.infer<typeof ToolRequestProposalSchema>;
export type ToolRequest = z.infer<typeof ToolRequestSchema>;
export type ToolAuthorizationBundle = z.infer<typeof ToolAuthorizationBundleSchema>;
export type ToolSideEffect = z.infer<typeof ToolSideEffectSchema>;
export type ToolEvidence = z.infer<typeof ToolEvidenceSchema>;
