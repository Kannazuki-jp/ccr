import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizePathScopePattern,
  normalizeWorkspacePath,
  pathMatchesResourceScope,
  WorkspacePathError,
} from "../../src/index.js";

describe("Workspace path helpers", () => {
  it("keeps agent-facing paths canonical and permits root only when requested", () => {
    assert.equal(normalizeWorkspacePath("src/auth/index.ts"), "src/auth/index.ts");
    assert.equal(normalizeWorkspacePath(".", { allowRoot: true }), ".");

    for (const value of ["", "/tmp/file", "C:\\temp\\file", "\\\\server\\share", "src/../secret", "src\\..\\secret", "src//file", "a\0b", "."]) {
      assert.throws(() => normalizeWorkspacePath(value), WorkspacePathError, value);
    }
  });

  it("matches only exact paths or a segment-aware trailing subtree", () => {
    const subtree = { type: "path", pattern: "src\\auth\\**" } as const;
    assert.equal(normalizePathScopePattern(subtree.pattern), "src/auth/**");
    assert.equal(pathMatchesResourceScope(subtree, "src/auth"), true);
    assert.equal(pathMatchesResourceScope(subtree, "src/auth/index.ts"), true);
    assert.equal(pathMatchesResourceScope(subtree, "src/auth/service/login.ts"), true);
    assert.equal(pathMatchesResourceScope(subtree, "src/authentication/index.ts"), false);
    assert.equal(pathMatchesResourceScope({ type: "path", pattern: "src/auth/index.ts" }, "src/auth/index.ts"), true);
    assert.equal(pathMatchesResourceScope({ type: "path", pattern: "src/auth/index.ts" }, "src/auth/other.ts"), false);
    assert.equal(pathMatchesResourceScope({ type: "global" }, "src/auth/index.ts"), false);
  });

  it("rejects escaping, ambiguous, and generic-glob scope patterns", () => {
    for (const pattern of ["/src/**", "C:\\src\\**", "src/../secret", "src//auth/**", "src/*/index.ts", "src/**/index.ts", "src/./auth/**", "src\0/auth/**"]) {
      assert.throws(() => normalizePathScopePattern(pattern), WorkspacePathError, pattern);
    }
    assert.equal(normalizePathScopePattern("./src/**"), "src/**");
    assert.equal(pathMatchesResourceScope({ type: "path", pattern: "**" }, "README.md"), true);
  });
});
