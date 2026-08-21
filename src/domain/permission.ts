import { z } from "zod";

import { NonEmptyTextSchema } from "./schemas.js";

export const ResourceScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("global") }).strict(),
  z
    .object({
      type: z.literal("mission"),
      missionId: NonEmptyTextSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("task"),
      taskId: NonEmptyTextSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("path"),
      pattern: NonEmptyTextSchema.refine(
        (pattern) => {
          const normalized = pattern.replaceAll("\\", "/");
          return (
            !normalized.startsWith("/") &&
            !/^[A-Za-z]:\//.test(normalized) &&
            !normalized.split("/").includes("..")
          );
        },
        "path scope must be relative and must not contain parent traversal",
      ),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool"),
      tool: NonEmptyTextSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("custom"),
      key: NonEmptyTextSchema,
      value: NonEmptyTextSchema,
    })
    .strict(),
]);

export const PermissionSchema = z
  .object({
    action: NonEmptyTextSchema,
    resource: ResourceScopeSchema,
  })
  .strict();

export type ResourceScope = z.infer<typeof ResourceScopeSchema>;
export type Permission = z.infer<typeof PermissionSchema>;
