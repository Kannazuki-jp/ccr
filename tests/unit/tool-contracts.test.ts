import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RepoListInputSchema,
  RepoPatchInputSchema,
  RepoReadInputSchema,
  RepoSearchInputSchema,
  TestRunInputSchema,
  ToolEvidenceSchema,
  bindToolRequest,
  InvalidToolInputError,
  InvalidToolRequestError,
  parseToolRequestProposal,
  UnsupportedToolError,
  ToolRequestProposalSchema,
  ToolRequestSchema,
  toolActionFor,
} from "../../src/domain/index.js";

const ids = {
  request: "00000000-0000-4000-8000-000000000001",
  evidence: "00000000-0000-4000-8000-000000000002",
  mission: "00000000-0000-4000-8000-000000000003",
  task: "00000000-0000-4000-8000-000000000004",
  selection: "00000000-0000-4000-8000-000000000005",
  operation: "00000000-0000-4000-8000-000000000006",
};
const hash = "a".repeat(64);

function validRequest(tool: string, input: object): object {
  return {
    id: ids.request,
    missionId: ids.mission,
    taskId: ids.task,
    actorId: "worker-1",
    attempt: 1,
    sequence: 1,
    tool,
    input,
    requestedAt: "2026-08-23T00:00:00.000Z",
  };
}

function validEvidence(tool: string, observation: object, overrides: object = {}): object {
  return {
    id: ids.evidence,
    requestId: ids.request,
    authorization: {
      selectionAuthorizationId: ids.selection,
      operationAuthorizationIds: [ids.operation],
      normalizedResources: [{ type: "path", pattern: "src/a.ts" }],
      digest: hash,
    },
    missionId: ids.mission,
    taskId: ids.task,
    actorId: "worker-1",
    attempt: 1,
    sequence: 1,
    tool,
    sideEffects: [],
    status: "succeeded",
    observation,
    startedAt: "2026-08-23T00:00:00.000Z",
    finishedAt: "2026-08-23T00:00:00.050Z",
    durationMs: 50,
    outputSha256: hash,
    truncated: false,
    ...overrides,
  };
}

describe("ToolRequest contract", () => {
  it("accepts each of the five canonical tools and maps their Doctrine action deterministically", () => {
    const inputs = [
      ["repo.list", RepoListInputSchema, { path: ".", maxDepth: 1 }, "code.read"],
      ["repo.search", RepoSearchInputSchema, { query: "needle", paths: ["src"], maxResults: 10 }, "code.read"],
      ["repo.read", RepoReadInputSchema, { path: "src/a.ts", offset: 0, limit: 100 }, "code.read"],
      ["repo.patch", RepoPatchInputSchema, { path: "src/a.ts", operation: "create", content: "export {};" }, "code.edit"],
      ["test.run", TestRunInputSchema, { commandId: "unit" }, "test.run"],
    ] as const;

    for (const [tool, inputSchema, input, action] of inputs) {
      assert.equal(inputSchema.safeParse(input).success, true, tool);
      assert.equal(ToolRequestSchema.safeParse(validRequest(tool, input)).success, true, tool);
      assert.equal(toolActionFor(tool), action, tool);
    }
  });

  it("keeps agent proposals separate from Runtime-owned identity and timestamp fields", () => {
    assert.equal(ToolRequestProposalSchema.safeParse({
      tool: "repo.read",
      input: { path: "src/a.ts", offset: 0, limit: 1 },
    }).success, true);
    assert.equal(ToolRequestProposalSchema.safeParse({
      tool: "repo.read",
      input: { path: "src/a.ts", offset: 0, limit: 1 },
      id: ids.request,
    }).success, false);
    const bound = bindToolRequest(
      { tool: "repo.read", input: { path: "src/a.ts", offset: 0, limit: 1 } },
      {
        id: ids.request,
        missionId: ids.mission,
        taskId: ids.task,
        actorId: "worker-1",
        attempt: 1,
        sequence: 1,
        requestedAt: "2026-08-23T00:00:00.000Z",
      },
    );
    assert.equal(bound.id, ids.request);
    assert.equal(bound.actorId, "worker-1");
  });

  it("fails closed for unknown tools, mismatched inputs, extra fields, and invalid paths", () => {
    assert.equal(ToolRequestProposalSchema.safeParse({ tool: "shell.run", input: {} }).success, false);
    assert.equal(ToolRequestProposalSchema.safeParse({ tool: "repo.read", input: { path: "a", maxDepth: 1 } }).success, false);
    assert.equal(RepoReadInputSchema.safeParse({ path: "/etc/passwd", offset: 0, limit: 1 }).success, false);
    assert.equal(RepoReadInputSchema.safeParse({ path: "src/../secret", offset: 0, limit: 1 }).success, false);
    assert.equal(RepoReadInputSchema.safeParse({ path: "src\\a.ts", offset: 0, limit: 1 }).success, false);
    assert.equal(RepoListInputSchema.safeParse({ path: ".", maxDepth: 0, recursive: true }).success, false);
    assert.throws(() => parseToolRequestProposal({ tool: "shell.run", input: {} }), UnsupportedToolError);
    assert.throws(() => parseToolRequestProposal({ tool: "repo.read", input: { path: "/x", offset: 0, limit: 1 } }), InvalidToolInputError);
    assert.throws(() => parseToolRequestProposal(null), InvalidToolRequestError);
  });

  it("enforces complete-replacement patch preconditions", () => {
    assert.equal(RepoPatchInputSchema.safeParse({ path: "a.ts", operation: "update", content: "x" }).success, false);
    assert.equal(RepoPatchInputSchema.safeParse({ path: "a.ts", operation: "delete", expectedSha256: hash, content: "x" }).success, false);
    assert.equal(RepoPatchInputSchema.safeParse({ path: "a.ts", operation: "create", content: "x", expectedSha256: hash }).success, false);
  });
});

describe("ToolEvidence contract", () => {
  it("accepts a fully observed success for every built-in tool", () => {
    const observations = [
      ["repo.list", { entries: [{ path: "src", kind: "directory", size: 0 }] }],
      ["repo.search", { matches: [{ path: "src/a.ts", line: 1, column: 1, excerpt: "needle" }], scannedFileCount: 1 }],
      ["repo.read", { offset: 0, bytesRead: 1, totalBytes: 1, contentSha256: hash }],
      ["repo.patch", { operation: "create", beforeSha256: null, afterSha256: hash, bytes: 1 }],
      ["test.run", { commandId: "unit", exitCode: 0, signal: null, stdout: { summary: "ok", sha256: hash, bytes: 2 }, stderr: { summary: "none", sha256: hash, bytes: 0 } }],
    ] as const;

    for (const [tool, observation] of observations) {
      const evidence = tool === "repo.patch"
        ? validEvidence(tool, observation, { sideEffects: [{ path: "a.ts", operation: "create", beforeSha256: null, afterSha256: hash, applied: true }] })
        : validEvidence(tool, observation);
      assert.equal(ToolEvidenceSchema.safeParse(evidence).success, true, tool);
    }
  });

  it("allows partial observations only for a failed or timed-out execution", () => {
    const failed = validEvidence("repo.read", {}, {
      status: "timed_out",
      error: { code: "deadline", message: "read deadline elapsed" },
    });
    assert.equal(ToolEvidenceSchema.safeParse(failed).success, true);
  });

  it("rejects unverifiable or inconsistent evidence", () => {
    const read = validEvidence("repo.read", { offset: 0, bytesRead: 1, totalBytes: 1, contentSha256: hash });
    assert.equal(ToolEvidenceSchema.safeParse({ ...read, sideEffects: [{ path: "a", operation: "update", beforeSha256: hash, afterSha256: hash, applied: true }] }).success, false);
    assert.equal(ToolEvidenceSchema.safeParse({ ...read, finishedAt: "2026-08-22T23:59:59.999Z" }).success, false);
    assert.equal(ToolEvidenceSchema.safeParse({ ...read, durationMs: 51 }).success, false);
    assert.equal(ToolEvidenceSchema.safeParse({
      ...read,
      authorization: {
        selectionAuthorizationId: ids.selection,
        operationAuthorizationIds: [ids.operation, ids.operation],
        normalizedResources: [{ type: "path", pattern: "src/a.ts" }],
        digest: hash,
      },
    }).success, false);

    const patch = validEvidence("repo.patch", { operation: "create", beforeSha256: null, afterSha256: hash, bytes: 1 });
    assert.equal(ToolEvidenceSchema.safeParse(patch).success, false);

    const test = validEvidence("test.run", { commandId: "unit", exitCode: null, signal: null, stdout: { summary: "ok", sha256: hash, bytes: 2 }, stderr: { summary: "none", sha256: hash, bytes: 0 } });
    assert.equal(ToolEvidenceSchema.safeParse(test).success, false);
    assert.equal(ToolEvidenceSchema.safeParse({ ...read, extra: true }).success, false);
  });

  it("round-trips persisted JSON through schema hydration", () => {
    const original = validEvidence("repo.read", { offset: 0, bytesRead: 1, totalBytes: 1, contentSha256: hash });
    const hydrated = ToolEvidenceSchema.parse(JSON.parse(JSON.stringify(original)));
    assert.ok(hydrated.startedAt instanceof Date);
    assert.equal(JSON.stringify(hydrated), JSON.stringify(ToolEvidenceSchema.parse(original)));
  });
});
