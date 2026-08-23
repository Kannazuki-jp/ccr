import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  InvalidPatchError,
  Workspace,
  WorkspaceBinaryFileError,
  WorkspaceFilesystemError,
  WorkspaceLimitError,
  WorkspacePathError,
  WorkspaceProtectedPathError,
  WorkspaceSymlinkError,
  WorkspaceTargetError,
} from "../../src/index.js";

async function withWorkspace(
  run: (input: { readonly root: string; readonly outside: string }) => Promise<void>,
): Promise<void> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "c2-workspace-"));
  const root = path.join(temporary, "repo");
  const outside = path.join(temporary, "repository-other");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  try {
    await run({ root, outside });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasCode<T extends { readonly code: string }>(type: abstract new (...args: never[]) => T, code: string): (error: unknown) => boolean {
  return (error): error is T => error instanceof type && error.code === code;
}

describe("Workspace root and path boundary", () => {
  it("requires an existing directory root and returns only normalized relative paths", async () => {
    await withWorkspace(async ({ root, outside }) => {
      const workspace = await Workspace.create({ rootPath: root });
      await fs.mkdir(path.join(root, "src"));
      await fs.writeFile(path.join(root, "src", "a.ts"), "answer");
      assert.deepEqual(await workspace.resolvePath("src/a.ts"), {
        path: "src/a.ts",
        exists: true,
        kind: "file",
      });
      assert.deepEqual(await workspace.resolvePath("missing.ts"), {
        path: "missing.ts",
        exists: false,
        kind: "missing",
      });
      const fileRoot = path.join(root, "not-a-directory");
      await fs.writeFile(fileRoot, "not a directory");
      await assert.rejects(() => Workspace.create({ rootPath: fileRoot }), {
        name: "WorkspaceRootError",
        code: "WORKSPACE_ROOT_INVALID",
      });
    });
    await assert.rejects(() => Workspace.create({ rootPath: path.join(os.tmpdir(), "not-a-c2-workspace") }), {
      name: "WorkspaceRootError",
      code: "WORKSPACE_ROOT_INVALID",
    });
  });

  it("fails closed for malformed paths before filesystem access", async () => {
    await withWorkspace(async ({ root }) => {
      const workspace = await Workspace.create({ rootPath: root });
      for (const candidate of ["/tmp/file", "C:\\temp\\file", "\\\\server\\share", "src/../secret", "src\\..\\secret", "a//b", "a\0b"]) {
        await assert.rejects(() => workspace.resolvePath(candidate), hasCode(WorkspacePathError, "WORKSPACE_INVALID_PATH"), candidate);
      }
      await assert.rejects(
        () => workspace.read({ path: ".", offset: 0, limit: 1 }),
        hasCode(WorkspacePathError, "WORKSPACE_INVALID_PATH"),
      );
    });
  });

  it("detects outside symlink file, directory, and creation-parent escapes without leaking data", async () => {
    await withWorkspace(async ({ root, outside }) => {
      await fs.writeFile(path.join(outside, "secret.txt"), "outside secret");
      await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "escape-file"));
      await fs.symlink(outside, path.join(root, "escape-directory"));
      const workspace = await Workspace.create({ rootPath: root });

      await assert.rejects(
        () => workspace.read({ path: "escape-file", offset: 0, limit: 100 }),
        hasCode(WorkspaceSymlinkError, "WORKSPACE_ESCAPE"),
      );
      await assert.rejects(
        () => workspace.read({ path: "escape-directory/secret.txt", offset: 0, limit: 100 }),
        hasCode(WorkspaceSymlinkError, "WORKSPACE_ESCAPE"),
      );
      await assert.rejects(
        () => workspace.validatePatch({ path: "escape-directory/new.txt", operation: "create", content: "new" }),
        hasCode(WorkspaceSymlinkError, "WORKSPACE_ESCAPE"),
      );
      assert.equal(await fs.readFile(path.join(outside, "secret.txt"), "utf8"), "outside secret");
      await assert.rejects(() => workspace.list({ path: "escape-directory", maxDepth: 1 }), hasCode(WorkspaceSymlinkError, "WORKSPACE_ESCAPE"));
    });
  });

  it("does not dereference even within-root symlinks, while list observes them without recursion", async () => {
    await withWorkspace(async ({ root }) => {
      await fs.mkdir(path.join(root, "src"));
      await fs.writeFile(path.join(root, "src", "a.ts"), "answer");
      await fs.symlink("src/a.ts", path.join(root, "inside-file"));
      await fs.symlink("src", path.join(root, "inside-directory"));
      const workspace = await Workspace.create({ rootPath: root });

      await assert.rejects(
        () => workspace.read({ path: "inside-file", offset: 0, limit: 10 }),
        hasCode(WorkspaceSymlinkError, "WORKSPACE_SYMLINK_DISALLOWED"),
      );
      await assert.rejects(
        () => workspace.search({ query: "answer", paths: ["inside-directory"], maxResults: 10 }),
        hasCode(WorkspaceSymlinkError, "WORKSPACE_SYMLINK_DISALLOWED"),
      );
      const list = await workspace.list({ path: ".", maxDepth: 3 });
      assert.deepEqual(list.entries.map((entry) => entry.path), ["inside-directory", "inside-file", "src", "src/a.ts"]);
      assert.equal(list.entries.find((entry) => entry.path === "inside-directory")?.kind, "symlink");
      assert.equal(list.entries.some((entry) => entry.path.startsWith("inside-directory/")), false);
    });
  });

  it("reserves .git independently of caller behavior", async () => {
    await withWorkspace(async ({ root }) => {
      await fs.mkdir(path.join(root, ".git"));
      await fs.writeFile(path.join(root, ".git", "config"), "[core]");
      const workspace = await Workspace.create({ rootPath: root });
      for (const target of [".git", ".git/config", ".git/objects/pack"]) {
        await assert.rejects(() => workspace.resolvePath(target, { allowRoot: true }), WorkspaceProtectedPathError, target);
      }
      await assert.rejects(() => workspace.read({ path: ".git/config", offset: 0, limit: 10 }), WorkspaceProtectedPathError);
      await assert.rejects(
        () => workspace.validatePatch({ path: ".git/config", operation: "create", content: "x" }),
        WorkspaceProtectedPathError,
      );
      assert.deepEqual(await workspace.list({ path: ".", maxDepth: 2 }), { entries: [] });
    });
  });

  it("protects credential-sensitive paths across every Workspace operation", async () => {
    await withWorkspace(async ({ root }) => {
      const protectedPaths = [".env", ".env.local", "config/private.pem", "keys/secret.key"];
      await fs.mkdir(path.join(root, "config"));
      await fs.mkdir(path.join(root, "keys"));
      for (const relativePath of protectedPaths) {
        await fs.writeFile(path.join(root, relativePath), "credential needle");
      }
      await fs.writeFile(path.join(root, "public.txt"), "public needle");
      const workspace = await Workspace.create({ rootPath: root });

      for (const relativePath of protectedPaths) {
        await assert.rejects(
          () => workspace.resolvePath(relativePath),
          hasCode(WorkspaceProtectedPathError, "WORKSPACE_PROTECTED_PATH"),
        );
        await assert.rejects(
          () => workspace.read({ path: relativePath, offset: 0, limit: 100 }),
          hasCode(WorkspaceProtectedPathError, "WORKSPACE_PROTECTED_PATH"),
        );
        await assert.rejects(
          () => workspace.search({ query: "needle", paths: [relativePath], maxResults: 10 }),
          hasCode(WorkspaceProtectedPathError, "WORKSPACE_PROTECTED_PATH"),
        );
        await assert.rejects(
          () => workspace.validatePatch({ path: relativePath, operation: "create", content: "replacement" }),
          hasCode(WorkspaceProtectedPathError, "WORKSPACE_PROTECTED_PATH"),
        );
      }

      const listed = await workspace.list({ path: ".", maxDepth: 3 });
      assert.deepEqual(listed.entries.map((entry) => entry.path), ["config", "keys", "public.txt"]);
      const searched = await workspace.search({ query: "needle", paths: ["."], maxResults: 10 });
      assert.deepEqual(searched.matches.map((match) => match.path), ["public.txt"]);
    });
  });

  it("sanitizes filesystem failures and symlink failures without absolute path disclosure", {
    skip: process.platform === "win32" || process.getuid?.() === 0,
  }, async () => {
    await withWorkspace(async ({ root, outside }) => {
      const privateFile = path.join(root, "private.txt");
      const privateDirectory = path.join(root, "private-directory");
      await fs.writeFile(privateFile, "private");
      await fs.mkdir(privateDirectory);
      await fs.writeFile(path.join(outside, "secret.txt"), "outside");
      await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "escape"));
      const workspace = await Workspace.create({ rootPath: root });

      await fs.chmod(privateFile, 0o000);
      await fs.chmod(privateDirectory, 0o000);
      try {
        for (const operation of [
          () => workspace.read({ path: "private.txt", offset: 0, limit: 10 }),
          () => workspace.search({ query: "private", paths: ["private.txt"], maxResults: 10 }),
          () => workspace.list({ path: "private-directory", maxDepth: 1 }),
          () => workspace.resolvePath("private-directory/child.txt"),
        ]) {
          await assert.rejects(operation, (error: unknown) => {
            assert.ok(error instanceof WorkspaceFilesystemError);
            assert.equal(error.code, "WORKSPACE_FILESYSTEM_ERROR");
            assert.equal(error.message.includes(root), false);
            assert.equal(error.message.includes(outside), false);
            assert.equal(error.cause, undefined);
            return true;
          });
        }
        await assert.rejects(
          () => workspace.read({ path: "escape", offset: 0, limit: 10 }),
          (error: unknown) => {
            assert.ok(error instanceof WorkspaceSymlinkError);
            assert.equal(error.code, "WORKSPACE_ESCAPE");
            assert.equal(error.message.includes(root), false);
            assert.equal(error.message.includes(outside), false);
            return true;
          },
        );
      } finally {
        await fs.chmod(privateFile, 0o600);
        await fs.chmod(privateDirectory, 0o700);
      }
    });
  });
});

describe("Workspace bounded repository primitives", () => {
  it("lists in lexicographic order, respects depth, and fails with a typed output limit", async () => {
    await withWorkspace(async ({ root }) => {
      await fs.mkdir(path.join(root, "src", "nested"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "z.ts"), "z");
      await fs.writeFile(path.join(root, "src", "a.ts"), "a");
      await fs.writeFile(path.join(root, "src", "nested", "b.ts"), "b");
      const workspace = await Workspace.create({ rootPath: root });
      const shallow = await workspace.list({ path: "src", maxDepth: 1 });
      assert.deepEqual(shallow.entries.map((entry) => entry.path), ["src/a.ts", "src/nested", "src/z.ts"]);
      const deep = await workspace.list({ path: "src", maxDepth: 2 });
      assert.deepEqual(deep.entries.map((entry) => entry.path), ["src/a.ts", "src/nested", "src/nested/b.ts", "src/z.ts"]);
      const limited = await Workspace.create({ rootPath: root, maxListEntries: 1 });
      await assert.rejects(() => limited.list({ path: "src", maxDepth: 1 }), WorkspaceLimitError);
      const outputLimited = await Workspace.create({ rootPath: root, maxListBytes: 1 });
      await assert.rejects(() => outputLimited.list({ path: "src", maxDepth: 1 }), WorkspaceLimitError);
    });
  });

  it("reads a bounded byte range with the whole-file hash and rejects directories, binary files, and size excess", async () => {
    await withWorkspace(async ({ root }) => {
      await fs.mkdir(path.join(root, "src"));
      await fs.writeFile(path.join(root, "src", "text.txt"), "abcdef");
      await fs.writeFile(path.join(root, "src", "binary.bin"), Buffer.from([0x61, 0x00, 0x62]));
      await fs.writeFile(path.join(root, "src", "invalid-utf8.bin"), Buffer.from([0xc3, 0x28]));
      const workspace = await Workspace.create({ rootPath: root, maxReadBytes: 8 });
      assert.deepEqual(await workspace.read({ path: "src/text.txt", offset: 2, limit: 2 }), {
        path: "src/text.txt",
        offset: 2,
        bytesRead: 2,
        totalBytes: 6,
        content: "cd",
        contentSha256: sha256("abcdef"),
      });
      assert.deepEqual(await workspace.read({ path: "src/text.txt", offset: 99, limit: 2 }), {
        path: "src/text.txt",
        offset: 99,
        bytesRead: 0,
        totalBytes: 6,
        content: "",
        contentSha256: sha256("abcdef"),
      });
      await assert.rejects(() => workspace.read({ path: "src", offset: 0, limit: 1 }), WorkspaceTargetError);
      await assert.rejects(() => workspace.read({ path: "src/binary.bin", offset: 0, limit: 3 }), WorkspaceBinaryFileError);
      await assert.rejects(() => workspace.read({ path: "src/invalid-utf8.bin", offset: 0, limit: 2 }), WorkspaceBinaryFileError);
      await assert.rejects(() => workspace.read({ path: "src/text.txt", offset: 0, limit: 9 }), WorkspaceLimitError);
      await fs.writeFile(path.join(root, "src", "too-large.txt"), "012345678");
      await assert.rejects(() => workspace.read({ path: "src/too-large.txt", offset: 0, limit: 1 }), WorkspaceLimitError);
    });
  });

  it("performs literal, ordered search over validated roots with bounded and binary-safe behavior", async () => {
    await withWorkspace(async ({ root, outside }) => {
      await fs.mkdir(path.join(root, "src"));
      await fs.writeFile(path.join(root, "src", "b.ts"), "needle on b\nneedle twice");
      await fs.writeFile(path.join(root, "src", "a.ts"), "needle on a");
      await fs.writeFile(path.join(root, "src", "binary.bin"), Buffer.from([0x00, 0x6e]));
      await fs.mkdir(path.join(root, ".git"));
      await fs.writeFile(path.join(root, ".git", "hidden.txt"), "needle hidden");
      await fs.symlink("../src/a.ts", path.join(root, "linked.ts"));
      await fs.symlink(path.join(outside), path.join(root, "escape"));
      await fs.writeFile(path.join(outside, "outside.ts"), "needle outside");
      const workspace = await Workspace.create({ rootPath: root, maxSearchResults: 2, maxSearchFileBytes: 64 });

      const search = await workspace.search({ query: "needle", paths: ["src/b.ts", "src/a.ts"], maxResults: 2 });
      assert.deepEqual(search, {
        matches: [
          { path: "src/a.ts", line: 1, column: 1, excerpt: "needle on a" },
          { path: "src/b.ts", line: 1, column: 1, excerpt: "needle on b" },
        ],
        scannedFileCount: 2,
        truncated: true,
      });
      const rootSearch = await workspace.search({ query: "needle", paths: ["."], maxResults: 2 });
      assert.equal(rootSearch.matches.some((match) => match.path.startsWith(".git/")), false);
      assert.equal(rootSearch.matches.some((match) => match.path === "linked.ts"), false);
      assert.equal(rootSearch.matches.some((match) => match.path.startsWith("escape/")), false);
      assert.equal(rootSearch.scannedFileCount, 2);
      assert.deepEqual(await workspace.search({ query: "absent", paths: ["src"], maxResults: 2 }), {
        matches: [],
        scannedFileCount: 2,
        truncated: false,
      });
      await assert.rejects(
        () => workspace.search({ query: "needle", paths: ["src/a.ts", "escape"], maxResults: 1 }),
        hasCode(WorkspaceSymlinkError, "WORKSPACE_ESCAPE"),
      );
      await assert.rejects(() => workspace.search({ query: "needle", paths: ["src"], maxResults: 3 }), WorkspaceLimitError);
      await fs.writeFile(path.join(root, "src", "large.ts"), "x".repeat(65));
      await assert.rejects(() => workspace.search({ query: "x", paths: ["src/large.ts"], maxResults: 1 }), WorkspaceLimitError);
      const countLimited = await Workspace.create({ rootPath: root, maxSearchFiles: 1 });
      await assert.rejects(() => countLimited.search({ query: "needle", paths: ["src"], maxResults: 1 }), WorkspaceLimitError);
    });
  });

  it("counts unique direct and recursively discovered search files against one budget", async () => {
    await withWorkspace(async ({ root }) => {
      await fs.mkdir(path.join(root, "src"));
      await fs.writeFile(path.join(root, "src", "a.ts"), "needle a");
      await fs.writeFile(path.join(root, "src", "b.ts"), "needle b");

      const oneFile = await Workspace.create({ rootPath: root, maxSearchFiles: 1 });
      await assert.rejects(
        () => oneFile.search({ query: "needle", paths: ["src/a.ts", "src/b.ts"], maxResults: 10 }),
        hasCode(WorkspaceLimitError, "WORKSPACE_LIMIT_EXCEEDED"),
      );
      await assert.rejects(
        () => oneFile.search({ query: "needle", paths: ["src"], maxResults: 10 }),
        hasCode(WorkspaceLimitError, "WORKSPACE_LIMIT_EXCEEDED"),
      );

      assert.deepEqual(
        await oneFile.search({ query: "needle", paths: ["src/a.ts"], maxResults: 10 }),
        {
          matches: [{ path: "src/a.ts", line: 1, column: 1, excerpt: "needle a" }],
          scannedFileCount: 1,
          truncated: false,
        },
      );

      const twoFiles = await Workspace.create({ rootPath: root, maxSearchFiles: 2 });
      const overlapping = await twoFiles.search({ query: "needle", paths: ["src/a.ts", "src"], maxResults: 10 });
      assert.deepEqual(overlapping.matches.map((match) => match.path), ["src/a.ts", "src/b.ts"]);
      assert.equal(overlapping.scannedFileCount, 2);
    });
  });

  it("validates one complete-replacement patch target without mutating it", async () => {
    await withWorkspace(async ({ root, outside }) => {
      await fs.mkdir(path.join(root, "src"));
      await fs.writeFile(path.join(root, "src", "a.ts"), "before");
      await fs.symlink(outside, path.join(root, "escape"));
      const workspace = await Workspace.create({ rootPath: root, maxPatchBytes: 8 });
      const expectedSha256 = sha256("before");

      assert.deepEqual(await workspace.validatePatch({ path: "src/new.ts", operation: "create", content: "new" }), {
        path: "src/new.ts",
        operation: "create",
        targetExists: false,
        existingParentPath: "src",
        beforeSha256: null,
        contentBytes: 3,
      });
      assert.deepEqual(await workspace.validatePatch({ path: "src/a.ts", operation: "update", content: "after", expectedSha256 }), {
        path: "src/a.ts",
        operation: "update",
        targetExists: true,
        existingParentPath: "src",
        beforeSha256: expectedSha256,
        contentBytes: 5,
      });
      assert.deepEqual(await workspace.validatePatch({ path: "src/a.ts", operation: "delete", expectedSha256 }), {
        path: "src/a.ts",
        operation: "delete",
        targetExists: true,
        existingParentPath: "src",
        beforeSha256: expectedSha256,
        contentBytes: 0,
      });
      assert.equal(await fs.readFile(path.join(root, "src", "a.ts"), "utf8"), "before");

      await assert.rejects(() => workspace.validatePatch({ path: "src/a.ts", operation: "create", content: "again" }), InvalidPatchError);
      await assert.rejects(
        () => workspace.validatePatch({ path: "src/a.ts", operation: "update", content: "after", expectedSha256: "0".repeat(64) }),
        hasCode(InvalidPatchError, "WORKSPACE_PATCH_PRECONDITION"),
      );
      await assert.rejects(() => workspace.validatePatch({ path: "src/missing.ts", operation: "delete", expectedSha256 }), InvalidPatchError);
      await assert.rejects(() => workspace.validatePatch({ path: "escape/new.ts", operation: "create", content: "new" }), hasCode(WorkspaceSymlinkError, "WORKSPACE_ESCAPE"));
      await assert.rejects(() => workspace.validatePatch({ path: "src/a.ts", operation: "update", content: "x".repeat(9), expectedSha256 }), WorkspaceLimitError);
    });
  });
});
