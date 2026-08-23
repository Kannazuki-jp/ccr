/**
 * @file Workspace-relative path and ResourceScope helpers.
 *
 * These helpers deliberately operate on the small v0.3 path language. They
 * are not a glob implementation and never convert a Repository path into an
 * unchecked host filesystem path.
 */

import {
  RelativeRepositoryPathSchema,
  ResourceScopeSchema,
} from "../domain/index.js";
import type { ResourceScope } from "../domain/index.js";

export type WorkspaceErrorCode =
  | "WORKSPACE_ROOT_INVALID"
  | "WORKSPACE_INVALID_PATH"
  | "WORKSPACE_ESCAPE"
  | "WORKSPACE_SYMLINK_DISALLOWED"
  | "WORKSPACE_PROTECTED_PATH"
  | "WORKSPACE_FILESYSTEM_ERROR"
  | "WORKSPACE_LIMIT_EXCEEDED"
  | "WORKSPACE_BINARY_FILE"
  | "WORKSPACE_INVALID_PATCH"
  | "WORKSPACE_PATCH_PRECONDITION"
  | "WORKSPACE_TARGET_INVALID";

/** Base class for deterministic, machine-readable Workspace failures. */
export class WorkspaceError extends Error {
  public constructor(
    public readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class WorkspaceRootError extends WorkspaceError {
  public constructor(message: string) {
    super("WORKSPACE_ROOT_INVALID", message);
  }
}

export class WorkspacePathError extends WorkspaceError {
  public constructor(message: string) {
    super("WORKSPACE_INVALID_PATH", message);
  }
}

export class WorkspaceBoundaryError extends WorkspaceError {
  public constructor(message: string) {
    super("WORKSPACE_ESCAPE", message);
  }
}

export class WorkspaceSymlinkError extends WorkspaceError {
  public constructor(code: "WORKSPACE_ESCAPE" | "WORKSPACE_SYMLINK_DISALLOWED", message: string) {
    super(code, message);
  }
}

export class WorkspaceProtectedPathError extends WorkspaceError {
  public constructor() {
    super("WORKSPACE_PROTECTED_PATH", "The requested path is protected by the Workspace policy");
  }
}

export class WorkspaceFilesystemError extends WorkspaceError {
  public constructor() {
    super("WORKSPACE_FILESYSTEM_ERROR", "A Repository filesystem operation failed");
  }
}

export class WorkspaceLimitError extends WorkspaceError {
  public constructor(message: string) {
    super("WORKSPACE_LIMIT_EXCEEDED", message);
  }
}

export class WorkspaceBinaryFileError extends WorkspaceError {
  public constructor() {
    super("WORKSPACE_BINARY_FILE", "The requested file is not UTF-8 text");
  }
}

export class InvalidPatchError extends WorkspaceError {
  public constructor(
    message: string,
    code: "WORKSPACE_INVALID_PATCH" | "WORKSPACE_PATCH_PRECONDITION" = "WORKSPACE_INVALID_PATCH",
  ) {
    super(code, message);
  }
}

export class WorkspacePatchPreconditionError extends InvalidPatchError {
  public constructor() {
    super("The patch expectedSha256 does not match the current file", "WORKSPACE_PATCH_PRECONDITION");
  }
}

export class WorkspaceTargetError extends WorkspaceError {
  public constructor(message: string) {
    super("WORKSPACE_TARGET_INVALID", message);
  }
}

export interface NormalizeWorkspacePathOptions {
  /** Only directory-oriented operations may address the Workspace root. */
  readonly allowRoot?: boolean;
}

/**
 * Validates the canonical, agent-facing Repository path representation.
 * Paths are already canonical on success; unlike ResourceScope patterns they
 * intentionally do not accept alternate separators or dot segments.
 */
export function normalizeWorkspacePath(
  value: unknown,
  options: NormalizeWorkspacePathOptions = {},
): string {
  const parsed = RelativeRepositoryPathSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkspacePathError("Path must be a canonical Workspace-relative POSIX path");
  }
  if (parsed.data === "." && options.allowRoot !== true) {
    throw new WorkspacePathError("The Workspace root is not valid for this operation");
  }
  return parsed.data;
}

type ProtectedPathRule = (segments: readonly string[]) => boolean;

/**
 * Runtime-owned v0.3 protected-path policy. New internal Repository paths can
 * be added here without changing individual Workspace operations.
 */
const WORKSPACE_PROTECTED_PATH_RULES: readonly ProtectedPathRule[] = [
  (segments) => segments[0] === ".git",
  (segments) => segments.some((segment) => segment.startsWith(".env")),
  (segments) => segments.some((segment) => segment.endsWith(".pem")),
  (segments) => segments.some((segment) => segment.endsWith(".key")),
];

export function isWorkspacePathProtected(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return WORKSPACE_PROTECTED_PATH_RULES.some((rule) => rule(segments));
}

/** Protected paths are reserved independently of ResourceScope breadth. */
export function assertWorkspacePathIsNotProtected(relativePath: string): void {
  if (isWorkspacePathProtected(relativePath)) {
    throw new WorkspaceProtectedPathError();
  }
}

interface NormalizedPathScope {
  readonly basePath: string;
  readonly subtree: boolean;
}

/**
 * Normalizes the deliberately small path-scope language: exact paths and a
 * trailing `/**` subtree marker. Backslashes are normalized only for scopes,
 * because ResourceScope is an authority expression rather than Tool input.
 */
export function normalizePathScopePattern(pattern: unknown): string {
  const parsed = ResourceScopeSchema.safeParse({ type: "path", pattern });
  if (!parsed.success || typeof pattern !== "string") {
    throw new WorkspacePathError("Path scope must be a relative path pattern");
  }

  let normalized = pattern.replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized.length === 0) normalized = ".";

  if (
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    throw new WorkspacePathError("Path scope must remain inside the Workspace");
  }

  if (normalized === "." || normalized === "**") return normalized;

  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new WorkspacePathError("Path scope contains an ambiguous or escaping segment");
  }

  const subtree = segments.at(-1) === "**";
  if (segments.some((segment, index) => segment.includes("*") && (segment !== "**" || !subtree || index !== segments.length - 1))) {
    throw new WorkspacePathError("Path scope supports only a trailing subtree marker");
  }
  return normalized;
}

/**
 * Determines inclusion for a normalized Repository path without making an
 * authorization decision. Non-path ResourceScopes never match here.
 */
export function pathMatchesResourceScope(
  scope: ResourceScope,
  relativePath: string,
): boolean {
  const normalizedPath = normalizeWorkspacePath(relativePath, { allowRoot: true });
  if (scope.type !== "path") return false;

  const normalizedScope = parseNormalizedPathScope(scope.pattern);
  if (!normalizedScope.subtree) return normalizedScope.basePath === normalizedPath;
  if (normalizedScope.basePath === ".") return true;
  return (
    normalizedPath === normalizedScope.basePath ||
    normalizedPath.startsWith(`${normalizedScope.basePath}/`)
  );
}

function parseNormalizedPathScope(pattern: unknown): NormalizedPathScope {
  const normalized = normalizePathScopePattern(pattern);
  if (normalized === "**") return { basePath: ".", subtree: true };
  if (!normalized.endsWith("/**")) return { basePath: normalized, subtree: false };
  return { basePath: normalized.slice(0, -3), subtree: true };
}
