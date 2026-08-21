import type { Permission, ResourceScope } from "../../domain/index.js";

export function actionMatches(granted: string, requested: string): boolean {
  if (granted === "*" || granted === requested) return true;
  return granted.endsWith(".*") && requested.startsWith(granted.slice(0, -1));
}

export function scopeContains(
  parent: ResourceScope,
  child: ResourceScope,
): boolean {
  if (parent.type === "global") return true;
  if (parent.type !== child.type) return false;

  switch (parent.type) {
    case "mission":
      return child.type === "mission" && parent.missionId === child.missionId;
    case "task":
      return child.type === "task" && parent.taskId === child.taskId;
    case "tool":
      return child.type === "tool" && parent.tool === child.tool;
    case "custom":
      return (
        child.type === "custom" &&
        parent.key === child.key &&
        parent.value === child.value
      );
    case "path":
      return child.type === "path" && pathPatternContains(parent.pattern, child.pattern);
  }
}

export function permissionContains(
  parent: Permission,
  child: Permission,
): boolean {
  return (
    actionMatches(parent.action, child.action) &&
    scopeContains(parent.resource, child.resource)
  );
}

export function permissionAllows(
  permission: Permission,
  action: string,
  resource: ResourceScope,
): boolean {
  return actionMatches(permission.action, action) && scopeContains(permission.resource, resource);
}

export interface PermissionScopeContext {
  readonly missionId: string;
  readonly taskId?: string;
}

export function permissionContainsInContext(
  parent: Permission,
  child: Permission,
  context: PermissionScopeContext,
): boolean {
  return (
    actionMatches(parent.action, child.action) &&
    contextualScopeContains(parent.resource, child.resource, context)
  );
}

export function permissionAllowsInContext(
  permission: Permission,
  action: string,
  resource: ResourceScope,
  context: PermissionScopeContext,
): boolean {
  return (
    actionMatches(permission.action, action) &&
    contextualScopeContains(permission.resource, resource, context)
  );
}

function contextualScopeContains(
  parent: ResourceScope,
  child: ResourceScope,
  context: PermissionScopeContext,
): boolean {
  if (parent.type === "mission") {
    if (parent.missionId !== context.missionId || child.type === "global") {
      return false;
    }
    return child.type !== "mission" || child.missionId === parent.missionId;
  }
  if (parent.type === "task") {
    if (
      context.taskId === undefined ||
      parent.taskId !== context.taskId ||
      child.type === "global" ||
      child.type === "mission"
    ) {
      return false;
    }
    return child.type !== "task" || child.taskId === parent.taskId;
  }
  return scopeContains(parent, child);
}

function pathPatternContains(parent: string, child: string): boolean {
  const normalizedParent = normalizePathPattern(parent);
  const normalizedChild = normalizePathPattern(child);
  if (normalizedParent === "**" || normalizedParent === normalizedChild) return true;
  if (!normalizedParent.endsWith("/**")) return false;

  const prefix = normalizedParent.slice(0, -3);
  const childPrefix = normalizedChild.endsWith("/**")
    ? normalizedChild.slice(0, -3)
    : normalizedChild;
  return childPrefix === prefix || childPrefix.startsWith(`${prefix}/`);
}

function normalizePathPattern(pattern: string): string {
  return pattern.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}
