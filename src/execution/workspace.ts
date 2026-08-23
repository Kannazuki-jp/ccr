/**
 * @file Runtime-owned, bounded Repository Workspace primitives.
 *
 * The Workspace follows no symlink for dereferencing operations. A symlink
 * can be observed by `list`, but read, search roots, and patch targets reject
 * it even when it resolves inside the root. This conservative policy keeps
 * the ToolBroker-facing API deterministic and prevents a symlink from being a
 * hidden alternate Repository path.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";

import {
  RepoListInputSchema,
  RepoPatchInputSchema,
  RepoReadInputSchema,
  RepoSearchInputSchema,
} from "../domain/index.js";
import type {
  RepoListInput,
  RepoPatchInput,
  RepoReadInput,
  RepoSearchInput,
} from "../domain/index.js";
import {
  assertWorkspacePathIsNotProtected,
  InvalidPatchError,
  isWorkspacePathProtected,
  normalizeWorkspacePath,
  WorkspaceBinaryFileError,
  WorkspaceBoundaryError,
  WorkspaceFilesystemError,
  WorkspaceLimitError,
  WorkspacePatchPreconditionError,
  WorkspacePathError,
  WorkspaceRootError,
  WorkspaceSymlinkError,
  WorkspaceTargetError,
} from "./workspace-path.js";

export interface WorkspaceOptions {
  /** Runtime-owned filesystem location. It is never returned by Workspace methods. */
  readonly rootPath: string;
  readonly maxReadBytes?: number;
  readonly maxPatchBytes?: number;
  readonly maxSearchResults?: number;
  readonly maxSearchFileBytes?: number;
  readonly maxSearchFiles?: number;
  readonly maxListEntries?: number;
  readonly maxListBytes?: number;
}

export interface WorkspacePath {
  readonly path: string;
  readonly exists: boolean;
  readonly kind: "file" | "directory" | "other" | "missing";
}

export interface WorkspaceListEntry {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink";
  readonly size: number;
}

export interface WorkspaceListResult {
  readonly entries: readonly WorkspaceListEntry[];
}

export interface WorkspaceSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly excerpt: string;
}

export interface WorkspaceSearchResult {
  readonly matches: readonly WorkspaceSearchMatch[];
  readonly scannedFileCount: number;
  readonly truncated: boolean;
}

export interface WorkspaceReadResult {
  readonly path: string;
  readonly offset: number;
  readonly bytesRead: number;
  readonly totalBytes: number;
  readonly content: string;
  readonly contentSha256: string;
}

export interface ValidatedPatch {
  readonly path: string;
  readonly operation: RepoPatchInput["operation"];
  readonly targetExists: boolean;
  readonly existingParentPath: string;
  readonly beforeSha256: string | null;
  readonly contentBytes: number;
}

interface WorkspaceLimits {
  readonly maxReadBytes: number;
  readonly maxPatchBytes: number;
  readonly maxSearchResults: number;
  readonly maxSearchFileBytes: number;
  readonly maxSearchFiles: number;
  readonly maxListEntries: number;
  readonly maxListBytes: number;
}

interface ResolvedPath {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly exists: boolean;
  readonly kind: WorkspacePath["kind"];
  readonly stats?: Stats;
  readonly existingParentPath: string;
}

const DEFAULT_LIMITS: WorkspaceLimits = {
  maxReadBytes: 32_768,
  maxPatchBytes: 131_072,
  maxSearchResults: 1_000,
  maxSearchFileBytes: 262_144,
  maxSearchFiles: 10_000,
  maxListEntries: 10_000,
  maxListBytes: 1_048_576,
};

/**
 * Runtime-owned Repository boundary. It exposes only normalized relative
 * paths and typed observations; canonical host paths remain private.
 */
export class Workspace {
  readonly maxReadBytes: number;
  readonly maxPatchBytes: number;
  readonly maxSearchResults: number;

  readonly #canonicalRootPath: string;
  readonly #limits: WorkspaceLimits;

  private constructor(canonicalRootPath: string, limits: WorkspaceLimits) {
    this.#canonicalRootPath = canonicalRootPath;
    this.#limits = limits;
    this.maxReadBytes = limits.maxReadBytes;
    this.maxPatchBytes = limits.maxPatchBytes;
    this.maxSearchResults = limits.maxSearchResults;
  }

  /** Canonicalizes and checks the Runtime-configured root before use. */
  public static async create(options: WorkspaceOptions): Promise<Workspace> {
    if (typeof options?.rootPath !== "string" || options.rootPath.length === 0) {
      throw new WorkspaceRootError("Workspace root must be a configured directory");
    }
    const limits = createLimits(options);
    const configuredAbsolutePath = path.resolve(options.rootPath);
    let canonicalRootPath: string;
    try {
      canonicalRootPath = await fs.realpath(configuredAbsolutePath);
      const rootStats = await fs.stat(canonicalRootPath);
      if (!rootStats.isDirectory()) {
        throw new WorkspaceRootError("Workspace root must be a directory");
      }
    } catch (error) {
      if (error instanceof WorkspaceRootError) throw error;
      throw new WorkspaceRootError("Workspace root must exist and be a directory");
    }
    return new Workspace(canonicalRootPath, limits);
  }

  /**
   * Resolves a safe relative path without exposing its host filesystem path.
   * Existing symlinks are always rejected by the v0.3 conservative policy.
   */
  public async resolvePath(relativePath: string, options: { readonly allowRoot?: boolean } = {}): Promise<WorkspacePath> {
    const normalizedPath = normalizeWorkspacePath(relativePath, { allowRoot: options.allowRoot === true });
    assertWorkspacePathIsNotProtected(normalizedPath);
    const resolved = await this.#resolve(normalizedPath, true);
    return {
      path: resolved.relativePath,
      exists: resolved.exists,
      kind: resolved.kind,
    };
  }

  public async list(input: RepoListInput): Promise<WorkspaceListResult> {
    const parsed = RepoListInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new WorkspacePathError("Repository list input is invalid");
    }
    const relativePath = this.#normalizeOperationPath(parsed.data.path, true);
    const target = await this.#resolveExisting(relativePath);
    if (target.kind !== "directory") {
      throw new WorkspaceTargetError("Repository list requires a directory");
    }

    const entries: WorkspaceListEntry[] = [];
    const budget = { bytes: 0 };
    await this.#collectListEntries(target.absolutePath, relativePath, 0, parsed.data.maxDepth, entries, budget);
    entries.sort(compareByPath);
    return { entries };
  }

  public async search(input: RepoSearchInput): Promise<WorkspaceSearchResult> {
    const parsed = RepoSearchInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new WorkspacePathError("Repository search input is invalid");
    }
    if (parsed.data.maxResults > this.#limits.maxSearchResults) {
      throw new WorkspaceLimitError("Requested search result count exceeds the Workspace limit");
    }

    // Validate every root before content from any root is read.
    const roots = await Promise.all(parsed.data.paths.map(async (candidate) => {
      const relativePath = this.#normalizeOperationPath(candidate, true);
      return this.#resolveExisting(relativePath);
    }));
    if (roots.some((root) => root.kind !== "file" && root.kind !== "directory")) {
      throw new WorkspaceTargetError("Repository search requires file or directory roots");
    }

    const files = new Set<string>();
    for (const root of roots) {
      if (root.kind === "file") {
        this.#addSearchFile(files, root.relativePath);
      } else {
        await this.#collectSearchFiles(root.absolutePath, root.relativePath, files);
      }
    }

    const matches: WorkspaceSearchMatch[] = [];
    let scannedFileCount = 0;
    for (const relativePath of [...files].sort(compareStrings)) {
      const file = await this.#resolveExisting(relativePath);
      if (file.kind !== "file") {
        throw new WorkspaceTargetError("Repository search encountered a non-file target");
      }
      let content: Buffer;
      try {
        content = await this.#readUtf8File(file, this.#limits.maxSearchFileBytes);
      } catch (error) {
        // Search deliberately skips binary/non-UTF-8 files. A direct read is
        // stricter and reports the same condition to its caller.
        if (error instanceof WorkspaceBinaryFileError) continue;
        throw error;
      }
      scannedFileCount += 1;
      for (const match of findLiteralMatches(content, parsed.data.query, relativePath)) {
        if (matches.length === parsed.data.maxResults) {
          return { matches, scannedFileCount, truncated: true };
        }
        matches.push(match);
      }
    }
    return { matches, scannedFileCount, truncated: false };
  }

  public async read(input: RepoReadInput): Promise<WorkspaceReadResult> {
    const parsed = RepoReadInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new WorkspacePathError("Repository read input is invalid");
    }
    if (parsed.data.limit > this.#limits.maxReadBytes) {
      throw new WorkspaceLimitError("Requested read size exceeds the Workspace limit");
    }
    const relativePath = this.#normalizeOperationPath(parsed.data.path, false);
    const file = await this.#resolveExisting(relativePath);
    if (file.kind !== "file") {
      throw new WorkspaceTargetError("Repository read requires a file");
    }
    const contents = await this.#readUtf8File(file, this.#limits.maxReadBytes);
    const requestedEnd = Math.min(contents.byteLength, parsed.data.offset + parsed.data.limit);
    const range = contents.subarray(Math.min(parsed.data.offset, contents.byteLength), requestedEnd);
    const content = decodeUtf8(range);
    return {
      path: relativePath,
      offset: parsed.data.offset,
      bytesRead: range.byteLength,
      totalBytes: contents.byteLength,
      content,
      contentSha256: sha256(contents),
    };
  }

  /**
   * Performs no mutation. Call this again immediately before a future patch
   * execution to re-check symlinks and the optimistic-concurrency hash.
   */
  public async validatePatch(input: RepoPatchInput): Promise<ValidatedPatch> {
    const parsed = RepoPatchInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new InvalidPatchError("Repository patch input is invalid");
    }
    const contentBytes = parsed.data.content === undefined ? 0 : Buffer.byteLength(parsed.data.content, "utf8");
    if (contentBytes > this.#limits.maxPatchBytes) {
      throw new WorkspaceLimitError("Patch content exceeds the Workspace limit");
    }

    const relativePath = this.#normalizeOperationPath(parsed.data.path, false);
    const target = await this.#resolve(relativePath, true);
    if (parsed.data.operation === "create") {
      if (target.exists) {
        throw new InvalidPatchError("Create patch target already exists");
      }
      return {
        path: relativePath,
        operation: parsed.data.operation,
        targetExists: false,
        existingParentPath: target.existingParentPath,
        beforeSha256: null,
        contentBytes,
      };
    }

    if (!target.exists || target.kind !== "file") {
      throw new InvalidPatchError("Update and delete patch targets must be existing files");
    }
    const before = await this.#readUtf8File(target, this.#limits.maxPatchBytes);
    const beforeSha256 = sha256(before);
    if (beforeSha256 !== parsed.data.expectedSha256) {
      throw new WorkspacePatchPreconditionError();
    }
    return {
      path: relativePath,
      operation: parsed.data.operation,
      targetExists: true,
      existingParentPath: target.existingParentPath,
      beforeSha256,
      contentBytes,
    };
  }

  #normalizeOperationPath(value: string, allowRoot: boolean): string {
    const normalizedPath = normalizeWorkspacePath(value, { allowRoot });
    assertWorkspacePathIsNotProtected(normalizedPath);
    return normalizedPath;
  }

  async #resolveExisting(relativePath: string): Promise<ResolvedPath> {
    const resolved = await this.#resolve(relativePath, false);
    if (!resolved.exists) throw new WorkspaceTargetError("Repository path does not exist");
    return resolved;
  }

  async #resolve(relativePath: string, allowMissing: boolean): Promise<ResolvedPath> {
    const segments = relativePath === "." ? [] : relativePath.split("/");
    let currentPath = this.#canonicalRootPath;
    let existingParentPath = ".";

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const candidate = path.join(currentPath, segment);
      const stats = await lstatIfExists(candidate);
      if (stats === undefined) {
        if (!allowMissing) throw new WorkspaceTargetError("Repository path does not exist");
        return {
          relativePath,
          absolutePath: path.join(currentPath, ...segments.slice(index)),
          exists: false,
          kind: "missing",
          existingParentPath,
        };
      }
      if (stats.isSymbolicLink()) {
        const canonicalTarget = await this.#realpath(candidate);
        if (!this.#isInsideRoot(canonicalTarget)) {
          throw new WorkspaceSymlinkError("WORKSPACE_ESCAPE", "A symlink escapes the Workspace");
        }
        const canonicalRelativePath = this.#relativeFromCanonicalPath(canonicalTarget);
        assertWorkspacePathIsNotProtected(canonicalRelativePath);
        throw new WorkspaceSymlinkError("WORKSPACE_SYMLINK_DISALLOWED", "Workspace operations do not follow symlinks");
      }

      const canonicalTarget = await this.#realpath(candidate);
      this.#assertInsideRoot(canonicalTarget);
      const canonicalRelativePath = this.#relativeFromCanonicalPath(canonicalTarget);
      assertWorkspacePathIsNotProtected(canonicalRelativePath);
      currentPath = canonicalTarget;
      existingParentPath = segments.slice(0, index + 1).join("/");

      if (index === segments.length - 1) {
        return {
          relativePath,
          absolutePath: currentPath,
          exists: true,
          kind: kindForStats(stats),
          stats,
          existingParentPath: segments.length === 1 ? "." : segments.slice(0, -1).join("/"),
        };
      }
    }

    const rootStats = await inspectExistingPath(this.#canonicalRootPath);
    return {
      relativePath,
      absolutePath: this.#canonicalRootPath,
      exists: true,
      kind: kindForStats(rootStats),
      stats: rootStats,
      existingParentPath: ".",
    };
  }

  async #collectListEntries(
    absoluteDirectoryPath: string,
    relativeDirectoryPath: string,
    depth: number,
    maxDepth: number,
    entries: WorkspaceListEntry[],
    budget: { bytes: number },
  ): Promise<void> {
    if (depth >= maxDepth) return;
    const names = await readDirectoryNames(absoluteDirectoryPath);
    names.sort(compareStrings);
    for (const name of names) {
      const relativePath = joinRelativePath(relativeDirectoryPath, name);
      if (isWorkspacePathProtected(relativePath)) continue;
      const candidate = path.join(absoluteDirectoryPath, name);
      const stats = await inspectExistingPath(candidate);
      const entry: WorkspaceListEntry = {
        path: relativePath,
        kind: listKindForStats(stats),
        size: stats.size,
      };
      this.#addListEntry(entries, entry, budget);
      if (entry.kind === "directory") {
        const revalidated = await this.#resolveExisting(relativePath);
        if (revalidated.kind !== "directory") {
          throw new WorkspaceTargetError("Repository list encountered a non-directory target");
        }
        await this.#collectListEntries(
          revalidated.absolutePath,
          relativePath,
          depth + 1,
          maxDepth,
          entries,
          budget,
        );
      }
    }
  }

  #addListEntry(entries: WorkspaceListEntry[], entry: WorkspaceListEntry, budget: { bytes: number }): void {
    if (entries.length === this.#limits.maxListEntries) {
      throw new WorkspaceLimitError("Repository list entry count exceeds the Workspace limit");
    }
    const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
    if (budget.bytes + bytes > this.#limits.maxListBytes) {
      throw new WorkspaceLimitError("Repository list output exceeds the Workspace limit");
    }
    budget.bytes += bytes;
    entries.push(entry);
  }

  async #collectSearchFiles(
    absoluteDirectoryPath: string,
    relativeDirectoryPath: string,
    files: Set<string>,
  ): Promise<void> {
    const names = await readDirectoryNames(absoluteDirectoryPath);
    names.sort(compareStrings);
    for (const name of names) {
      const relativePath = joinRelativePath(relativeDirectoryPath, name);
      if (isWorkspacePathProtected(relativePath)) continue;
      const candidate = path.join(absoluteDirectoryPath, name);
      const stats = await inspectExistingPath(candidate);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        const revalidated = await this.#resolveExisting(relativePath);
        if (revalidated.kind !== "directory") {
          throw new WorkspaceTargetError("Repository search encountered a non-directory target");
        }
        await this.#collectSearchFiles(revalidated.absolutePath, relativePath, files);
      } else if (stats.isFile()) {
        this.#addSearchFile(files, relativePath);
      }
    }
  }

  #addSearchFile(files: Set<string>, relativePath: string): void {
    if (files.has(relativePath)) return;
    if (files.size === this.#limits.maxSearchFiles) {
      throw new WorkspaceLimitError("Repository search file count exceeds the Workspace limit");
    }
    files.add(relativePath);
  }

  async #readUtf8File(file: ResolvedPath, maximumBytes: number): Promise<Buffer> {
    if (file.kind !== "file" || file.stats === undefined) {
      throw new WorkspaceTargetError("Repository target must be a file");
    }
    if (file.stats.size > maximumBytes) {
      throw new WorkspaceLimitError("Repository file exceeds the Workspace limit");
    }
    const revalidated = await this.#resolveExisting(file.relativePath);
    if (revalidated.kind !== "file") {
      throw new WorkspaceTargetError("Repository target changed before it could be read");
    }
    const contents = await readFileContents(revalidated.absolutePath);
    if (contents.byteLength > maximumBytes) {
      throw new WorkspaceLimitError("Repository file exceeds the Workspace limit");
    }
    decodeUtf8(contents);
    return contents;
  }

  async #realpath(candidate: string): Promise<string> {
    try {
      return await fs.realpath(candidate);
    } catch {
      throw new WorkspaceTargetError("Repository path could not be resolved");
    }
  }

  #assertInsideRoot(candidate: string): void {
    if (!this.#isInsideRoot(candidate)) {
      throw new WorkspaceBoundaryError("Repository path escapes the Workspace");
    }
  }

  #isInsideRoot(candidate: string): boolean {
    const relative = path.relative(this.#canonicalRootPath, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  }

  #relativeFromCanonicalPath(canonicalPath: string): string {
    const relative = path.relative(this.#canonicalRootPath, canonicalPath);
    if (relative === "") return ".";
    return relative.split(path.sep).join("/");
  }
}

function createLimits(options: WorkspaceOptions): WorkspaceLimits {
  return {
    maxReadBytes: positiveLimit(options.maxReadBytes, DEFAULT_LIMITS.maxReadBytes, "maxReadBytes"),
    maxPatchBytes: positiveLimit(options.maxPatchBytes, DEFAULT_LIMITS.maxPatchBytes, "maxPatchBytes"),
    maxSearchResults: positiveLimit(options.maxSearchResults, DEFAULT_LIMITS.maxSearchResults, "maxSearchResults"),
    maxSearchFileBytes: positiveLimit(options.maxSearchFileBytes, DEFAULT_LIMITS.maxSearchFileBytes, "maxSearchFileBytes"),
    maxSearchFiles: positiveLimit(options.maxSearchFiles, DEFAULT_LIMITS.maxSearchFiles, "maxSearchFiles"),
    maxListEntries: positiveLimit(options.maxListEntries, DEFAULT_LIMITS.maxListEntries, "maxListEntries"),
    maxListBytes: positiveLimit(options.maxListBytes, DEFAULT_LIMITS.maxListBytes, "maxListBytes"),
  };
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new WorkspaceRootError(`${name} must be a positive safe integer`);
  }
  return result;
}

async function lstatIfExists(candidate: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(candidate);
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw new WorkspaceFilesystemError();
  }
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function kindForStats(stats: Stats): WorkspacePath["kind"] {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  return "other";
}

function listKindForStats(stats: Stats): WorkspaceListEntry["kind"] {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "directory";
  return "file";
}

function joinRelativePath(parent: string, name: string): string {
  return parent === "." ? name : `${parent}/${name}`;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function readDirectoryNames(absolutePath: string): Promise<string[]> {
  try {
    return await fs.readdir(absolutePath);
  } catch {
    throw new WorkspaceFilesystemError();
  }
}

async function inspectExistingPath(absolutePath: string): Promise<Stats> {
  try {
    return await fs.lstat(absolutePath);
  } catch {
    throw new WorkspaceFilesystemError();
  }
}

async function readFileContents(absolutePath: string): Promise<Buffer> {
  try {
    return await fs.readFile(absolutePath);
  } catch {
    throw new WorkspaceFilesystemError();
  }
}

function compareByPath(left: WorkspaceListEntry, right: WorkspaceListEntry): number {
  return compareStrings(left.path, right.path);
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function decodeUtf8(content: Buffer): string {
  if (content.includes(0)) throw new WorkspaceBinaryFileError();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new WorkspaceBinaryFileError();
  }
}

function* findLiteralMatches(content: Buffer, query: string, relativePath: string): Generator<WorkspaceSearchMatch> {
  const text = decodeUtf8(content);
  let offset = 0;
  while (offset <= text.length) {
    const index = text.indexOf(query, offset);
    if (index === -1) return;
    const before = text.slice(0, index);
    const line = countLines(before) + 1;
    const lineStart = before.lastIndexOf("\n") + 1;
    const lineEnd = text.indexOf("\n", index);
    const sourceLine = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
    yield {
      path: relativePath,
      line,
      column: index - lineStart + 1,
      excerpt: excerptForLine(sourceLine, index - lineStart),
    };
    offset = index + Math.max(query.length, 1);
  }
}

function countLines(value: string): number {
  let lines = 0;
  for (const character of value) if (character === "\n") lines += 1;
  return lines;
}

function excerptForLine(line: string, column: number): string {
  const maximum = 320;
  if (line.length <= maximum) return line.length === 0 ? " " : line;
  const start = Math.max(0, column - Math.floor(maximum / 2));
  return line.slice(start, start + maximum);
}
