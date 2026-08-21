import { randomUUID } from "node:crypto";

import {
  AuthorityGrantSchema,
  DecisionRequestSchema,
  DelegationRequestSchema,
  EscalationRequestSchema,
  EscalationResolutionRequestSchema,
  MissionStatusSchema,
  RevocationRequestSchema,
  TaskStatusSchema,
  type AuthorityContext,
  type AuthorityGrant,
  type AuthorizationRecord,
  type AuthorizationResult,
  type DecisionRequest,
  type DelegationRequest,
  type DelegationResult,
  type DoctrineActorRole,
  type DoctrineViolation,
  type DoctrineViolationRecord,
  type EffectiveAuthority,
  type EscalationRecord,
  type EscalationRequest,
  type EscalationResolutionRequest,
  type EscalationResolutionResult,
  type EscalationResult,
  type Event,
  type RevocationRequest,
  type RevocationResult,
  type RoleAuthority,
} from "../../domain/index.js";
import {
  canTransitionMission,
  canTransitionTask,
} from "../state-machine.js";

import {
  AuthorityResolver,
  type AuthorityResolverOptions,
} from "./authority-resolver.js";
import {
  getDecisionOwner,
  getDecisionRight,
} from "./boundary-registry.js";
import { findConstraintViolation } from "./constraint-checker.js";
import { validateDelegation } from "./delegation-validator.js";
import {
  isValidEscalationRoute,
  routeEscalation,
} from "./escalation-router.js";
import {
  decisionBoundaryResource,
  decisionRequiresResource,
  decisionUsesTaskRisk,
  isCanonicalAction,
  resourceMatchesDecisionBoundary,
  resolvePermissionAction,
} from "./decision-contract.js";
import {
  permissionAllowsInContext,
  permissionContains,
  permissionContainsInContext,
} from "./permission.js";
import type {
  AuthorizationAudit,
  DoctrineStore,
} from "./repository.js";
import { findRiskLimitViolation } from "./risk-checker.js";

const genuineRuntimeTransitionAuthorizations = new WeakMap<
  object,
  DecisionRequest
>();
const genuineTaskAssignmentAuthorizations = new WeakMap<
  object,
  DecisionRequest
>();

/**
 * A one-shot authenticity check for the transition-permit boundary.
 * Registration remains module-private and only occurs after durable ALLOW audit.
 */
export function consumeRuntimeTransitionAuthorization(
  request: DecisionRequest,
  authorization: AuthorizationResult,
): boolean {
  const recorded = genuineRuntimeTransitionAuthorizations.get(authorization);
  if (
    recorded?.id !== request.id ||
    recorded.missionId !== request.missionId ||
    recorded.actorId !== request.actorId ||
    recorded.role !== request.role ||
    recorded.decisionType !== request.decisionType
  ) {
    return false;
  }
  genuineRuntimeTransitionAuthorizations.delete(authorization);
  return true;
}

/** One-shot authenticity check used by the task-assignment permit issuer. */
export function consumeTaskAssignmentAuthorization(
  request: DecisionRequest,
  authorization: AuthorizationResult,
): boolean {
  const recorded = genuineTaskAssignmentAuthorizations.get(authorization);
  const recordedWorker = recorded?.context?.workerAgentId;
  if (
    recorded?.id !== request.id ||
    recorded.missionId !== request.missionId ||
    recorded.taskId !== request.taskId ||
    recorded.actorId !== request.actorId ||
    recorded.role !== request.role ||
    recorded.decisionType !== "task.assign" ||
    request.decisionType !== "task.assign" ||
    typeof recordedWorker !== "string" ||
    recordedWorker !== request.context?.workerAgentId
  ) {
    return false;
  }
  genuineTaskAssignmentAuthorizations.delete(authorization);
  return true;
}

export interface DoctrineEnforcerOptions {
  readonly roleAuthorities?: readonly RoleAuthority[];
  readonly actorRoles?: Readonly<Record<string, DoctrineActorRole>>;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export interface DoctrineEnforcerApi {
  authorize(request: DecisionRequest): Promise<AuthorizationResult>;
  resolveEffectiveAuthority(
    actorId: string,
    context: AuthorityContext,
  ): Promise<EffectiveAuthority>;
  delegate(request: DelegationRequest): Promise<DelegationResult>;
  revoke(request: RevocationRequest): Promise<RevocationResult>;
  escalate(request: EscalationRequest): Promise<EscalationResult>;
  resolveEscalation(
    request: EscalationResolutionRequest,
  ): Promise<EscalationResolutionResult>;
}

/**
 * Doctrineの判定だけを決定論的に行うRuntime enforcement境界。
 * Agentの判断内容や成果の良し悪しは生成せず、権限・制約・状態だけを扱う。
 */
export class DoctrineEnforcer implements DoctrineEnforcerApi {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly resolver: AuthorityResolver;

  public constructor(
    private readonly store: DoctrineStore,
    private readonly options: DoctrineEnforcerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    const resolverOptions: AuthorityResolverOptions = {
      ...(options.roleAuthorities === undefined
        ? {}
        : { roleAuthorities: options.roleAuthorities }),
      now: this.now,
      createId: this.createId,
    };
    this.resolver = new AuthorityResolver(store, resolverOptions);
  }

  public async authorize(
    requestInput: DecisionRequest,
  ): Promise<AuthorizationResult> {
    // A structurally invalid request is rejected before audit fields are read.
    const submittedRequest = DecisionRequestSchema.parse(requestInput);
    this.store.appendEvent(
      this.event(submittedRequest.missionId, "DecisionRequested", submittedRequest.actorId, {
        requestId: submittedRequest.id,
        decisionType: submittedRequest.decisionType,
        action: submittedRequest.action,
      }),
    );

    const actualRole = this.resolveActorRole(submittedRequest.actorId);
    if (actualRole === undefined || actualRole !== submittedRequest.role) {
      return this.deny(
        submittedRequest,
        "COMMAND_BOUNDARY_VIOLATION",
        `Actor ${submittedRequest.actorId} is not registered as ${submittedRequest.role}`,
      );
    }

    if (!isCanonicalAction(submittedRequest.decisionType, submittedRequest.action)) {
      return this.deny(
        submittedRequest,
        "COMMAND_BOUNDARY_VIOLATION",
        `Action ${submittedRequest.action} is not valid for ${submittedRequest.decisionType}`,
      );
    }
    const permissionAction = resolvePermissionAction(
      submittedRequest.decisionType,
      submittedRequest.action,
    )!;
    // The v0.2 normative `action: "modify"` shape is a change request when
    // submitted by a non-owner. Canonical mutation actions remain direct and
    // therefore require the explicit request_change intent to be escalated.
    const requestsBoundaryChange =
      submittedRequest.context?.intent === "request_change" ||
      (submittedRequest.action === "modify" &&
        permissionAction === submittedRequest.decisionType);
    const storedTask = submittedRequest.taskId === undefined
      ? undefined
      : this.store.getTask(submittedRequest.taskId);
    const storedMission = this.store.getMission(submittedRequest.missionId);
    const boundaryResource = decisionBoundaryResource(
      submittedRequest,
      storedMission !== undefined,
    );
    const derivedResource =
      submittedRequest.resource ??
      (permissionAction === submittedRequest.decisionType
        ? boundaryResource
        : undefined);
    const contextWithoutRisk = Object.fromEntries(
      Object.entries(submittedRequest.context ?? {}).filter(
        ([key]) => key !== "risk",
      ),
    );
    const authoritativeRisk = decisionUsesTaskRisk(submittedRequest)
      ? storedTask?.risk ??
        (submittedRequest.decisionType === "task.create"
          ? submittedRequest.context?.risk
          : undefined)
      : storedMission !== undefined
        ? storedMission.intent.risk
        : (submittedRequest.decisionType === "goal.create" ||
            submittedRequest.decisionType === "mission.create")
          ? submittedRequest.context?.risk
          : undefined;
    const authoritativeContext = {
      ...contextWithoutRisk,
      ...(authoritativeRisk === undefined ? {} : { risk: authoritativeRisk }),
    };
    const request: DecisionRequest = {
      ...submittedRequest,
      action: permissionAction,
      ...(derivedResource === undefined ? {} : { resource: derivedResource }),
      context: authoritativeContext,
    };
    if (
      permissionAction === request.decisionType &&
      !resourceMatchesDecisionBoundary(request, boundaryResource)
    ) {
      return this.deny(
        request,
        "COMMAND_BOUNDARY_VIOLATION",
        `${request.decisionType} requires its ${boundaryResource?.type ?? "defined"} boundary resource`,
      );
    }

    const storedContextViolation = this.validateStoredRequestContext(request);
    if (storedContextViolation !== undefined) {
      return this.recordDeny(request, storedContextViolation);
    }
    const stateViolation = this.validateStateRequest(request);
    if (stateViolation !== undefined) {
      return this.recordDeny(request, stateViolation);
    }

    const owner = getDecisionOwner(request.decisionType);
    const right = getDecisionRight(request.role, request.decisionType);
    let effective: EffectiveAuthority | undefined;
    if (request.role === "evaluator" && owner !== "evaluator") {
      return this.deny(
        request,
        request.decisionType === "state.transition"
          ? "EVALUATOR_STATE_MUTATION"
          : "COMMAND_BOUNDARY_VIOLATION",
        "Evaluator has assessment authority but no command or state mutation authority",
      );
    }
    if (request.role === "runtime" && owner !== "runtime") {
      return this.deny(
        request,
        "COMMAND_BOUNDARY_VIOLATION",
        "Runtime enforces decisions but does not own command decisions",
      );
    }
    if (right === "delegated") {
      effective = await this.resolveEffectiveAuthority(request.actorId, {
        missionId: request.missionId,
        ...(request.taskId === undefined ||
        this.store.getTask(request.taskId) === undefined
          ? {}
          : { taskId: request.taskId }),
        role: request.role,
      });
      if (
        effective.grantIds.length === 0 ||
        request.resource === undefined ||
        !this.effectivePermissionAllows(effective, request)
      ) {
        return this.maybeEscalateOrDeny(
          request,
          owner,
          requestsBoundaryChange,
        );
      }
    } else if (right !== "owner" && right !== "verify" && right !== "enforce") {
      if (this.mustDenyCrossBoundary(request, owner)) {
        return this.deny(
          request,
          "COMMAND_BOUNDARY_VIOLATION",
          `${request.role} cannot exercise ${request.decisionType}`,
        );
      }
      return this.maybeEscalateOrDeny(
        request,
        owner,
        requestsBoundaryChange,
      );
    }

    const isPremissionCreate =
      this.store.getMission(request.missionId) === undefined &&
      (request.decisionType === "goal.create" ||
        request.decisionType === "mission.create");
    effective ??= isPremissionCreate
      ? this.resolver.resolve(request.actorId, {
          missionId: request.missionId,
          role: request.role,
        })
      : await this.resolveEffectiveAuthority(request.actorId, {
          missionId: request.missionId,
          ...(request.taskId === undefined ||
          this.store.getTask(request.taskId) === undefined
            ? {}
            : { taskId: request.taskId }),
          role: request.role,
        });

    if (
      request.resource === undefined &&
      decisionRequiresResource(request.decisionType)
    ) {
      return this.deny(
        request,
        "INSUFFICIENT_AUTHORITY",
        `Action ${request.action} requires an explicit resource scope`,
      );
    }
    if (request.resource === undefined) {
      return this.deny(
        request,
        "INSUFFICIENT_AUTHORITY",
        `Action ${request.action} has no enforceable resource scope`,
      );
    }
    const allowed = this.effectivePermissionAllows(effective, request);
    if (!allowed) {
      return this.denyForInactiveOrMissingAuthority(request, request.action);
    }

    const constraintViolation = findConstraintViolation(
      request,
      effective.constraints,
      this.now(),
    );
    if (constraintViolation !== undefined) {
      return this.recordDeny(request, constraintViolation);
    }
    const riskViolation = findRiskLimitViolation(
      request,
      effective.riskLimits,
      this.now(),
    );
    if (riskViolation !== undefined) {
      return this.recordDeny(request, riskViolation);
    }

    return this.allow(
      request,
      `${request.role} owns ${request.decisionType} within effective authority`,
    );
  }

  public async resolveEffectiveAuthority(
    actorId: string,
    context: AuthorityContext,
  ): Promise<EffectiveAuthority> {
    const actualRole = this.resolveActorRole(actorId);
    if (actualRole === undefined || actualRole !== context.role) {
      throw new Error(
        `Actor ${actorId} is not registered as ${context.role}`,
      );
    }
    const contextViolation = this.validateAuthorityContext(actorId, context);
    if (contextViolation !== undefined) {
      throw new Error(contextViolation.message);
    }
    return this.resolver.resolve(actorId, context);
  }

  public async delegate(
    requestInput: DelegationRequest,
  ): Promise<DelegationResult> {
    const request = DelegationRequestSchema.parse(requestInput);
    const now = this.now();
    const issuerRole = this.resolveActorRole(request.issuerId);
    const subjectRole = this.resolveActorRole(request.subjectId);
    const auditRequest = this.delegationAuditRequest(request, issuerRole ?? "lead", now);
    this.store.appendEvent(
      this.event(request.missionId, "DecisionRequested", request.issuerId, {
        requestId: auditRequest.id,
        decisionType: "authority.delegate",
        subjectId: request.subjectId,
      }),
    );

    if (issuerRole === undefined || subjectRole === undefined) {
      const denied = this.deny(
        auditRequest,
        "INVALID_DELEGATION",
        "Delegation issuer and subject must both be registered actors",
      );
      return { result: "deny", reason: denied.reason, violation: denied.violation };
    }
    const delegationContextViolation = this.validateDelegationContext(
      request,
      issuerRole,
      subjectRole,
      now,
    );
    if (delegationContextViolation !== undefined) {
      const denied = this.recordDeny(auditRequest, delegationContextViolation);
      return { result: "deny", reason: denied.reason, violation: denied.violation };
    }
    if (request.expiresAt !== undefined && request.expiresAt <= now) {
      const denied = this.deny(
        auditRequest,
        "INVALID_DELEGATION",
        "Delegation expiry must be in the future",
      );
      return { result: "deny", reason: denied.reason, violation: denied.violation };
    }

    const issuerAuthority = await this.resolveEffectiveAuthority(
      request.issuerId,
      {
        missionId: request.missionId,
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        role: issuerRole,
      },
    );
    const enforcedDelegationRequest = this.withAuthoritativeRiskContext(
      auditRequest,
    );
    if (!this.effectivePermissionAllows(issuerAuthority, enforcedDelegationRequest)) {
      const denied = this.deny(
        auditRequest,
        "INVALID_DELEGATION",
        "Issuer lacks effective authority.delegate permission for the requested scope",
      );
      return {
        result: "deny",
        reason: denied.reason,
        violation: denied.violation,
      };
    }
    const delegationConstraintViolation = findConstraintViolation(
      enforcedDelegationRequest,
      issuerAuthority.constraints,
      this.now(),
    );
    if (delegationConstraintViolation !== undefined) {
      const denied = this.recordDeny(auditRequest, delegationConstraintViolation);
      return { result: "deny", reason: denied.reason, violation: denied.violation };
    }
    const delegationRiskViolation = findRiskLimitViolation(
      enforcedDelegationRequest,
      issuerAuthority.riskLimits,
      this.now(),
    );
    if (delegationRiskViolation !== undefined) {
      const denied = this.recordDeny(auditRequest, delegationRiskViolation);
      return { result: "deny", reason: denied.reason, violation: denied.violation };
    }
    const availableParentGrants = issuerAuthority.grantIds
      .map((grantId) => this.store.getAuthorityGrant(grantId))
      .filter((grant): grant is AuthorityGrant => grant !== undefined);
    const selectedParentGrantIds = new Set<string>();
    for (const permission of request.permissions) {
      const selected = availableParentGrants
        .filter((grant) =>
          grant.permissions.some((parentPermission) =>
            permissionContainsInContext(parentPermission, permission, {
              missionId: request.missionId,
              ...(request.taskId === undefined
                ? {}
                : { taskId: request.taskId }),
            }),
          ),
        )
        .sort(compareGrantProvenance)[0];
      if (selected !== undefined) selectedParentGrantIds.add(selected.id);
    }
    const parentGrants = [...selectedParentGrantIds]
      .map((grantId) => this.store.getAuthorityGrant(grantId))
      .filter((grant): grant is AuthorityGrant => grant !== undefined);
    const parentExpirations = parentGrants
      .map(({ expiresAt }) => expiresAt)
      .filter((expiresAt): expiresAt is Date => expiresAt !== undefined);
    const earliestParentExpiration = parentExpirations.length === 0
      ? undefined
      : new Date(Math.min(...parentExpirations.map((date) => date.getTime())));
    if (
      earliestParentExpiration !== undefined &&
      (request.expiresAt === undefined ||
        request.expiresAt > earliestParentExpiration)
    ) {
      const denied = this.deny(
        auditRequest,
        "INVALID_DELEGATION",
        `Delegated authority must expire no later than ${earliestParentExpiration.toISOString()}`,
      );
      return { result: "deny", reason: denied.reason, violation: denied.violation };
    }
    const subjectMaximum = this.resolver.roleAuthority(
      request.subjectId,
      subjectRole,
    );
    const exceedsSubjectRole = request.permissions.find(
      (permission) =>
        !subjectMaximum.permissions.some((maximum) =>
          permissionContains(maximum, permission),
        ),
    );
    if (exceedsSubjectRole !== undefined) {
      const denied = this.deny(
        auditRequest,
        "INVALID_DELEGATION",
        `${exceedsSubjectRole.action} exceeds the subject role maximum`,
      );
      return { result: "deny", reason: denied.reason, violation: denied.violation };
    }

    const validation = validateDelegation(
      request,
      issuerAuthority,
      subjectRole,
      now,
    );
    if (!validation.ok) {
      const denied = this.recordDeny(auditRequest, validation.violation);
      return { result: "deny", reason: denied.reason, violation: denied.violation };
    }

    const grant = AuthorityGrantSchema.parse({
      id: this.createId(),
      issuerId: request.issuerId,
      subjectId: request.subjectId,
      missionId: request.missionId,
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
      permissions: request.permissions,
      constraints: validation.constraints,
      riskLimits: validation.riskLimits,
      ...(selectedParentGrantIds.size === 0
        ? {}
        : { parentGrantIds: [...selectedParentGrantIds].sort() }),
      status: "active",
      createdAt: now,
      ...(request.expiresAt === undefined
        ? {}
        : { expiresAt: request.expiresAt }),
    });
    const grantEvent = this.event(
      request.missionId,
      "AuthorityGranted",
      request.issuerId,
      {
        grantId: grant.id,
        subjectId: grant.subjectId,
        taskId: grant.taskId ?? null,
      },
    );
    const constraintEvents = grant.constraints.map((constraint) =>
      this.event(request.missionId, "ConstraintApplied", "runtime", {
          grantId: grant.id,
          constraintId: constraint.id,
          subjectId: grant.subjectId,
          inherited: constraint.inherited,
        }),
    );
    const reason = "Requested authority is a valid narrowing of issuer authority";
    const authorizationResult: AuthorizationResult = { result: "allow", reason };
    this.store.grantAuthorityWithAudit({
      grant,
      grantEvent,
      constraintEvents,
      authorization: this.buildAuthorizationAudit(
        auditRequest,
        authorizationResult,
      ),
    });
    return {
      result: "allow",
      reason,
      grant,
    };
  }

  public async revoke(
    requestInput: RevocationRequest,
  ): Promise<RevocationResult> {
    const request = RevocationRequestSchema.parse(requestInput);
    const grant = this.store.getAuthorityGrant(request.grantId);
    const now = this.now();
    const actorRole = this.resolveActorRole(request.actorId) ?? "lead";
    const auditRequest: DecisionRequest = {
      id: this.createId(),
      actorId: request.actorId,
      role: actorRole,
      missionId: grant?.missionId ?? "unknown-mission",
      ...(grant?.taskId === undefined ? {} : { taskId: grant.taskId }),
      decisionType: "authority.revoke",
      action: "authority.revoke",
      ...(grant === undefined
        ? {}
        : {
            resource:
              grant.taskId === undefined
                ? { type: "mission" as const, missionId: grant.missionId }
                : { type: "task" as const, taskId: grant.taskId },
          }),
      createdAt: now,
    };

    if (grant !== undefined) {
      this.store.appendEvent(
        this.event(grant.missionId, "DecisionRequested", request.actorId, {
          requestId: auditRequest.id,
          decisionType: "authority.revoke",
          grantId: grant.id,
          reason: request.reason,
        }),
      );
    }

    if (grant === undefined) {
      const denied = this.deny(
        auditRequest,
        "INVALID_DELEGATION",
        `Authority grant ${request.grantId} does not exist`,
      );
      return { result: "deny", reason: denied.reason, violation: denied.violation };
    }
    if (grant.status === "revoked") {
      const denied = this.deny(
        auditRequest,
        "REVOKED_AUTHORITY",
        `Authority grant ${grant.id} is already revoked`,
      );
      return { result: "deny", reason: denied.reason, violation: denied.violation };
    }
    if (
      grant.status === "expired" ||
      (grant.expiresAt !== undefined && grant.expiresAt <= now)
    ) {
      const denied = this.deny(
        auditRequest,
        "EXPIRED_AUTHORITY",
        `Authority grant ${grant.id} is expired`,
      );
      return { result: "deny", reason: denied.reason, violation: denied.violation };
    }
    if (request.actorId !== grant.issuerId) {
      const denied = this.deny(
        auditRequest,
        "COMMAND_BOUNDARY_VIOLATION",
        "Only the grant issuer may revoke this authority grant",
      );
      return { result: "deny", reason: denied.reason, violation: denied.violation };
    }
    const revokerAuthority = await this.resolveEffectiveAuthority(
      request.actorId,
      {
        missionId: grant.missionId,
        ...(grant.taskId === undefined ? {} : { taskId: grant.taskId }),
        role: actorRole,
      },
    );
    const enforcedRevocationRequest = this.withAuthoritativeRiskContext(auditRequest);
    const revocationPermissionRequest: DecisionRequest = {
      ...enforcedRevocationRequest,
      action: "authority.delegate",
    };
    if (!this.effectivePermissionAllows(revokerAuthority, revocationPermissionRequest)) {
      const denied = this.deny(
        auditRequest,
        "INSUFFICIENT_AUTHORITY",
        "Grant issuer lacks effective authority lifecycle permission for this scope",
      );
      return { result: "deny", reason: denied.reason, violation: denied.violation };
    }
    const authorizationResult: AuthorizationResult = {
      result: "allow",
      reason: request.reason,
    };
    const revoked = this.store.revokeAuthorityGrantWithAudit({
      grantId: grant.id,
      revokedAt: now,
      revokeEvent: this.event(grant.missionId, "AuthorityRevoked", request.actorId, {
        grantId: grant.id,
        reason: request.reason,
      }),
      authorization: this.buildAuthorizationAudit(
        auditRequest,
        authorizationResult,
      ),
    });
    return { result: "allow", reason: request.reason, grant: revoked };
  }

  public async escalate(
    requestInput: EscalationRequest,
  ): Promise<EscalationResult> {
    const request = EscalationRequestSchema.parse(requestInput);
    const requesterRole = this.resolveActorRole(request.requesterId);
    const expectedTarget =
      requesterRole === undefined
        ? undefined
        : routeEscalation(requesterRole, request.decisionType);
    const auditRequest: DecisionRequest = {
      id: request.id,
      actorId: request.requesterId,
      role: requesterRole ?? "worker",
      missionId: request.missionId,
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
      decisionType: request.decisionType,
      action: "escalate",
      createdAt: request.createdAt,
    };
    const storedContextViolation = this.validateStoredRequestContext(auditRequest);
    if (storedContextViolation !== undefined) {
      const denied = this.recordDeny(auditRequest, storedContextViolation);
      return { result: "deny", reason: denied.reason, violation: denied.violation };
    }
    if (
      requesterRole === undefined ||
      request.targetRole !== expectedTarget ||
      !isValidEscalationRoute(requesterRole, request.targetRole)
    ) {
      const denied = this.deny(
        auditRequest,
        "COMMAND_BOUNDARY_VIOLATION",
        `Escalation target must be ${expectedTarget ?? "a registered decision owner"}`,
      );
      return { result: "deny", reason: denied.reason, violation: denied.violation };
    }

    const escalation: EscalationRecord = {
      ...request,
      status: "open",
    };
    this.store.appendEvent(
      this.event(request.missionId, "DecisionRequested", request.requesterId, {
        requestId: request.id,
        decisionType: request.decisionType,
        intent: "request_change",
      }),
    );
    const result: AuthorizationResult = {
      result: "escalate",
      reason: request.reason,
      escalation,
    };
    this.store.saveEscalationWithAudit({
      escalation,
      escalationEvent: this.escalationEvent(escalation),
      authorization: this.buildAuthorizationAudit(auditRequest, result),
    });
    return { result: "escalate", reason: request.reason, escalation };
  }

  public async resolveEscalation(
    requestInput: EscalationResolutionRequest,
  ): Promise<EscalationResolutionResult> {
    const request = EscalationResolutionRequestSchema.parse(requestInput);
    const escalation = this.store.getEscalation(request.escalationId);
    const actorRole = this.resolveActorRole(request.actorId);
    if (escalation === undefined) {
      const violation: DoctrineViolation = {
        code: "COMMAND_BOUNDARY_VIOLATION",
        actorId: request.actorId,
        decisionType: "authority.delegate",
        message: `Escalation ${request.escalationId} does not exist`,
        createdAt: this.now(),
      };
      return { result: "deny", reason: violation.message, violation };
    }
    const auditRequest: DecisionRequest = {
      id: request.id,
      actorId: request.actorId,
      role: actorRole ?? "worker",
      missionId: escalation.missionId,
      ...(escalation.taskId === undefined
        ? {}
        : { taskId: escalation.taskId }),
      decisionType: escalation.decisionType,
      action: "resolve",
      createdAt: request.createdAt,
    };
    this.store.appendEvent(
      this.event(escalation.missionId, "DecisionRequested", request.actorId, {
        requestId: request.id,
        decisionType: escalation.decisionType,
        escalationId: escalation.id,
        intent: "resolve_escalation",
      }),
    );
    if (
      escalation.status !== "open" ||
      actorRole === undefined ||
      actorRole !== escalation.targetRole ||
      ((actorRole === "commander" || actorRole === "lead") &&
        !this.actorHasMissionBinding(
          request.actorId,
          actorRole,
          escalation.missionId,
        ))
    ) {
      const denied = this.deny(
        auditRequest,
        "COMMAND_BOUNDARY_VIOLATION",
        escalation.status !== "open"
          ? `Escalation ${escalation.id} is already resolved`
          : `Only a ${escalation.targetRole} actor may resolve escalation ${escalation.id}`,
      );
      return {
        result: "deny",
        reason: denied.reason,
        violation: denied.violation,
      };
    }

    const resolverAuthority = await this.resolveEffectiveAuthority(
      request.actorId,
      {
        missionId: escalation.missionId,
        ...(escalation.taskId === undefined
          ? {}
          : { taskId: escalation.taskId }),
        role: actorRole,
      },
    );
    const resolutionPermissionRequest = this.withAuthoritativeRiskContext({
      ...auditRequest,
      action: escalation.decisionType,
      resource: decisionBoundaryResource(auditRequest, true),
    });
    if (
      !this.effectivePermissionAllows(
        resolverAuthority,
        resolutionPermissionRequest,
      )
    ) {
      const denied = this.deny(
        auditRequest,
        "INSUFFICIENT_AUTHORITY",
        `${actorRole} lacks effective permission to resolve ${escalation.decisionType}`,
      );
      return { result: "deny", reason: denied.reason, violation: denied.violation };
    }
    const resolutionConstraintViolation = findConstraintViolation(
      resolutionPermissionRequest,
      resolverAuthority.constraints,
      this.now(),
    );
    if (resolutionConstraintViolation !== undefined) {
      const denied = this.recordDeny(auditRequest, resolutionConstraintViolation);
      return { result: "deny", reason: denied.reason, violation: denied.violation };
    }
    const resolutionRiskViolation = findRiskLimitViolation(
      resolutionPermissionRequest,
      resolverAuthority.riskLimits,
      this.now(),
    );
    if (resolutionRiskViolation !== undefined) {
      const denied = this.recordDeny(auditRequest, resolutionRiskViolation);
      return { result: "deny", reason: denied.reason, violation: denied.violation };
    }

    const resolutionTime = new Date(
      Math.max(this.now().getTime(), escalation.createdAt.getTime()),
    );
    const resolved: EscalationRecord = {
      ...escalation,
      status: "resolved",
      resolvedAt: resolutionTime,
    };
    const authorizationResult: AuthorizationResult = {
      result: "allow",
      reason: request.reason,
    };
    this.store.saveEscalationWithAudit({
      escalation: resolved,
      escalationEvent: this.event(
        escalation.missionId,
        "EscalationResolved",
        request.actorId,
        {
          escalationId: escalation.id,
          decisionType: escalation.decisionType,
          reason: request.reason,
        },
        resolutionTime,
      ),
      authorization: this.buildAuthorizationAudit(
        auditRequest,
        authorizationResult,
      ),
    });
    return {
      result: "allow",
      reason: request.reason,
      escalation: resolved,
    };
  }

  private resolveActorRole(actorId: string): DoctrineActorRole | undefined {
    const configured = this.options.actorRoles?.[actorId];
    if (configured !== undefined) return configured;
    if (actorId === "human" || actorId === "runtime") return actorId;
    const agent = this.store.getAgent(actorId);
    return agent?.role;
  }

  private mustDenyCrossBoundary(
    request: DecisionRequest,
    owner: DoctrineActorRole,
  ): boolean {
    if (owner === "runtime" || owner === "evaluator" || owner === "worker") {
      return true;
    }
    if (request.role === "worker" && request.decisionType.startsWith("goal.")) {
      return true;
    }
    if (
      request.decisionType === "mission.create" &&
      (request.role === "lead" || request.role === "worker")
    ) {
      return true;
    }
    return false;
  }

  private maybeEscalateOrDeny(
    request: DecisionRequest,
    owner: DoctrineActorRole,
    requestsBoundaryChange: boolean,
  ): AuthorizationResult {
    if (
      requestsBoundaryChange &&
      isValidEscalationRoute(request.role, owner)
    ) {
      return this.escalateAuthorization(request, owner);
    }
    return this.deny(
      request,
      "COMMAND_BOUNDARY_VIOLATION",
      `${request.role} cannot directly exercise ${request.decisionType}`,
    );
  }

  private validateStoredRequestContext(
    request: DecisionRequest,
  ): DoctrineViolation | undefined {
    const mission = this.store.getMission(request.missionId);
    const createsMission =
      request.decisionType === "goal.create" ||
      request.decisionType === "mission.create";
    if (mission === undefined && !createsMission) {
      return this.contextViolation(
        request,
        "INSUFFICIENT_AUTHORITY",
        `Mission ${request.missionId} does not exist`,
      );
    }
    if (
      mission !== undefined &&
      (request.role === "commander" || request.role === "lead") &&
      !this.actorHasMissionBinding(
        request.actorId,
        request.role,
        request.missionId,
      )
    ) {
      return this.contextViolation(
        request,
        "INSUFFICIENT_AUTHORITY",
        `${request.role} ${request.actorId} is not bound to mission ${request.missionId}`,
      );
    }
    if (
      mission !== undefined &&
      request.role === "worker" &&
      request.taskId === undefined
    ) {
      const hasAssignedTask = this.store
        .listTasks(request.missionId)
        .some(({ assignedAgentId }) => assignedAgentId === request.actorId);
      const now = this.now();
      const hasActiveGrant = this.store
        .listAuthorityGrants(request.missionId, request.actorId)
        .some(
          (grant) =>
            grant.status === "active" &&
            (grant.expiresAt === undefined || grant.expiresAt > now),
        );
      if (!hasAssignedTask && !hasActiveGrant) {
        return this.contextViolation(
          request,
          "INSUFFICIENT_AUTHORITY",
          `Worker ${request.actorId} is not bound to mission ${request.missionId}`,
        );
      }
    }
    const taskRequired =
      request.decisionType.startsWith("execution.") ||
      request.decisionType.startsWith("evaluation.") ||
      request.decisionType === "report.submit" ||
      (request.decisionType.startsWith("task.") &&
        request.decisionType !== "task.create") ||
      (request.decisionType === "state.transition" &&
        request.context?.entity === "task");
    const task =
      request.taskId === undefined
        ? undefined
        : this.store.getTask(request.taskId);
    if (request.decisionType === "task.create" && task !== undefined) {
      return this.contextViolation(
        request,
        "INVALID_STATE_TRANSITION",
        `Task ${request.taskId!} already exists`,
      );
    }
    if (
      request.taskId !== undefined &&
      request.decisionType !== "task.create" &&
      task === undefined
    ) {
      return this.contextViolation(
        request,
        "INSUFFICIENT_AUTHORITY",
        `Task ${request.taskId} does not exist`,
      );
    }
    if (taskRequired && request.taskId === undefined) {
      return this.contextViolation(
        request,
        "INSUFFICIENT_AUTHORITY",
        `${request.decisionType} requires a task`,
      );
    }
    if (task !== undefined && task.missionId !== request.missionId) {
      return this.contextViolation(
        request,
        "COMMAND_BOUNDARY_VIOLATION",
        `Task ${task.id} does not belong to mission ${request.missionId}`,
      );
    }
    if (
      request.role === "worker" &&
      task !== undefined &&
      task.assignedAgentId !== request.actorId
    ) {
      return this.contextViolation(
        request,
        "INSUFFICIENT_AUTHORITY",
        `Worker ${request.actorId} is not assigned to task ${task.id}`,
      );
    }
    if (
      request.resource?.type === "mission" &&
      request.resource.missionId !== request.missionId
    ) {
      return this.contextViolation(
        request,
        "COMMAND_BOUNDARY_VIOLATION",
        "Mission resource does not match the DecisionRequest mission",
      );
    }
    if (
      request.resource?.type === "task" &&
      (request.taskId === undefined ||
        request.resource.taskId !== request.taskId ||
        (task === undefined && request.decisionType !== "task.create"))
    ) {
      return this.contextViolation(
        request,
        "COMMAND_BOUNDARY_VIOLATION",
        "Task resource does not match an existing DecisionRequest task",
      );
    }
    return undefined;
  }

  private validateAuthorityContext(
    actorId: string,
    context: AuthorityContext,
  ): DoctrineViolation | undefined {
    const request: DecisionRequest = {
      id: "authority-context",
      actorId,
      role: context.role,
      missionId: context.missionId,
      ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
      decisionType: "authority.delegate",
      action: "authority.delegate",
      createdAt: context.at ?? this.now(),
    };
    if (this.store.getMission(context.missionId) === undefined) {
      return this.contextViolation(
        request,
        "INSUFFICIENT_AUTHORITY",
        `Mission ${context.missionId} does not exist`,
      );
    }
    if (
      (context.role === "commander" || context.role === "lead") &&
      !this.actorHasMissionBinding(actorId, context.role, context.missionId)
    ) {
      return this.contextViolation(
        request,
        "INSUFFICIENT_AUTHORITY",
        `${context.role} ${actorId} is not bound to mission ${context.missionId}`,
      );
    }
    if (context.taskId !== undefined) {
      const task = this.store.getTask(context.taskId);
      if (task === undefined || task.missionId !== context.missionId) {
        return this.contextViolation(
          request,
          "COMMAND_BOUNDARY_VIOLATION",
          `Task ${context.taskId} does not belong to mission ${context.missionId}`,
        );
      }
      if (context.role === "worker" && task.assignedAgentId !== actorId) {
        return this.contextViolation(
          request,
          "INSUFFICIENT_AUTHORITY",
          `Worker ${actorId} is not assigned to task ${task.id}`,
        );
      }
    }
    return undefined;
  }

  private validateDelegationContext(
    request: DelegationRequest,
    issuerRole: DoctrineActorRole,
    subjectRole: DoctrineActorRole,
    now: Date,
  ): DoctrineViolation | undefined {
    const fail = (message: string): DoctrineViolation => ({
      code: "INVALID_DELEGATION",
      actorId: request.issuerId,
      decisionType: "authority.delegate",
      message,
      createdAt: now,
    });
    if (this.store.getMission(request.missionId) === undefined) {
      return fail(`Mission ${request.missionId} does not exist`);
    }
    if (
      (issuerRole === "commander" || issuerRole === "lead") &&
      !this.actorHasMissionBinding(
        request.issuerId,
        issuerRole,
        request.missionId,
      )
    ) {
      return fail(
        `${issuerRole} ${request.issuerId} is not bound to mission ${request.missionId}`,
      );
    }
    if (request.issuerId === request.subjectId) {
      return fail("Self-delegation is not allowed");
    }
    const delegationRight = getDecisionRight(issuerRole, "authority.delegate");
    if (delegationRight !== "owner" && delegationRight !== "delegated") {
      return fail(`${issuerRole} has no authority delegation decision right`);
    }
    const ranks: Partial<Record<DoctrineActorRole, number>> = {
      human: 0,
      commander: 1,
      lead: 2,
      worker: 3,
    };
    const issuerRank = ranks[issuerRole];
    const subjectRank = ranks[subjectRole];
    if (
      issuerRank === undefined ||
      subjectRank === undefined ||
      subjectRank !== issuerRank + 1
    ) {
      return fail(`Delegation must follow the command chain: ${issuerRole} -> ${subjectRole}`);
    }
    if (subjectRole === "worker" && request.taskId === undefined) {
      return fail("Worker authority must be scoped to a task");
    }
    if (request.taskId !== undefined) {
      const task = this.store.getTask(request.taskId);
      if (task === undefined || task.missionId !== request.missionId) {
        return fail(
          `Task ${request.taskId} does not belong to mission ${request.missionId}`,
        );
      }
      if (
        subjectRole === "worker" &&
        task.assignedAgentId !== request.subjectId
      ) {
        return fail(
          `Worker ${request.subjectId} is not assigned to task ${task.id}`,
        );
      }
    }
    for (const permission of request.permissions) {
      if (
        permission.resource.type === "mission" &&
        permission.resource.missionId !== request.missionId
      ) {
        return fail("Delegated mission resource crosses the grant mission");
      }
      if (
        permission.resource.type === "task" &&
        (request.taskId === undefined ||
          permission.resource.taskId !== request.taskId)
      ) {
        return fail("Delegated task resource crosses the grant task");
      }
    }
    return undefined;
  }

  private actorHasMissionBinding(
    actorId: string,
    role: "commander" | "lead",
    missionId: string,
  ): boolean {
    if (
      role === "lead" &&
      this.store.listAuthorityGrants(missionId, actorId).length > 0
    ) {
      return true;
    }
    return this.store.listEvents(missionId).some((event) => {
      if (
        role === "commander" &&
        event.type === "MissionCreated" &&
        event.actor === actorId
      ) {
        return true;
      }
      if (
        typeof event.payload !== "object" ||
        event.payload === null ||
        Array.isArray(event.payload)
      ) {
        return false;
      }
      return role === "commander"
        ? event.type === "AuthorizationAllowed" &&
            event.payload.actorId === actorId &&
            event.payload.decisionType === "mission.create"
        : event.type === "AuthorityGranted" &&
            event.payload.subjectId === actorId;
    });
  }

  private contextViolation(
    request: DecisionRequest,
    code: DoctrineViolation["code"],
    message: string,
  ): DoctrineViolation {
    return {
      code,
      actorId: request.actorId,
      decisionType: request.decisionType,
      message,
      createdAt: this.now(),
    };
  }

  private validateStateRequest(
    request: DecisionRequest,
  ): DoctrineViolation | undefined {
    if (request.decisionType !== "state.transition") return undefined;
    if (request.role === "evaluator") return undefined;

    const entity = request.context?.entity;
    const from = request.context?.from;
    const to = request.context?.to;
    const mission = this.store.getMission(request.missionId);
    const task = request.taskId === undefined
      ? undefined
      : this.store.getTask(request.taskId);
    const valid =
      entity === "mission"
        ? mission !== undefined &&
          mission.status === from &&
          (request.context?.entityId === undefined ||
            request.context.entityId === mission.id) &&
          MissionStatusSchema.safeParse(from).success &&
          MissionStatusSchema.safeParse(to).success &&
          canTransitionMission(
            MissionStatusSchema.parse(from),
            MissionStatusSchema.parse(to),
          )
        : entity === "task"
          ? task !== undefined &&
            task.status === from &&
            (request.context?.entityId === undefined ||
              request.context.entityId === task.id) &&
            TaskStatusSchema.safeParse(from).success &&
            TaskStatusSchema.safeParse(to).success &&
            canTransitionTask(
              TaskStatusSchema.parse(from),
              TaskStatusSchema.parse(to),
            )
          : false;
    if (!valid) {
      return {
        code: "INVALID_STATE_TRANSITION",
        actorId: request.actorId,
        decisionType: request.decisionType,
        message: `Invalid ${String(entity)} state transition: ${String(from)} -> ${String(to)}`,
        createdAt: this.now(),
      };
    }
    if (
      entity === "task" &&
      to === "completed" &&
      request.context?.evaluationResult !== "pass"
    ) {
      return {
        code: "INVALID_STATE_TRANSITION",
        actorId: request.actorId,
        decisionType: request.decisionType,
        message: "Task completion requires an evaluator PASS result",
        createdAt: this.now(),
      };
    }
    if (entity === "task" && to === "completed") {
      const reportId = request.context?.reportId;
      const persistedReport =
        typeof reportId === "string" && request.taskId !== undefined
          ? this.store
              .listReports(request.missionId, request.taskId)
              .find(({ id }) => id === reportId)
          : undefined;
      const persistedPass =
        persistedReport !== undefined &&
        this.store.listEvents(request.missionId).some((event) => {
          if (event.type !== "EvaluationPassed") return false;
          if (
            typeof event.payload !== "object" ||
            event.payload === null ||
            Array.isArray(event.payload)
          ) {
            return false;
          }
          const evaluator = event.actor === undefined
            ? undefined
            : this.store.getAgent(event.actor);
          return (
            evaluator?.role === "evaluator" &&
            event.payload.taskId === request.taskId &&
            event.payload.reportId === reportId
          );
        });
      if (!persistedPass) {
        return {
          code: "INVALID_STATE_TRANSITION",
          actorId: request.actorId,
          decisionType: request.decisionType,
          message: "Task completion requires a persisted report and Evaluator PASS event",
          createdAt: this.now(),
        };
      }
    }
    return undefined;
  }

  private denyForInactiveOrMissingAuthority(
    request: DecisionRequest,
    requiredAction: string,
  ): AuthorizationResult {
    const now = this.now();
    const matching = this.store
      .listAuthorityGrants(request.missionId, request.actorId)
      .filter(
        (grant) =>
          (grant.taskId === undefined || grant.taskId === request.taskId) &&
          grant.permissions.some((permission) =>
            permissionAllowsInContext(
              permission,
              requiredAction,
              request.resource!,
              {
                missionId: request.missionId,
                ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
              },
            ),
          ),
      );
    if (matching.some(({ status }) => status === "revoked")) {
      return this.deny(
        request,
        "REVOKED_AUTHORITY",
        "The matching authority grant has been revoked",
      );
    }
    if (
      matching.some(
        ({ status, expiresAt }) =>
          status === "expired" ||
          (expiresAt !== undefined && expiresAt <= now),
      )
    ) {
      return this.deny(
        request,
        "EXPIRED_AUTHORITY",
        "The matching authority grant has expired",
      );
    }
    return this.deny(
      request,
      "INSUFFICIENT_AUTHORITY",
      "No effective permission covers the requested action and resource",
    );
  }

  private effectivePermissionAllows(
    effective: EffectiveAuthority,
    request: DecisionRequest,
  ): boolean {
    if (request.resource === undefined) return false;
    return effective.permissions.some((permission) =>
      permissionAllowsInContext(
        permission,
        request.action,
        request.resource!,
        {
          missionId: request.missionId,
          ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        },
      ),
    );
  }

  private withAuthoritativeRiskContext(
    request: DecisionRequest,
  ): DecisionRequest {
    const contextWithoutRisk = Object.fromEntries(
      Object.entries(request.context ?? {}).filter(([key]) => key !== "risk"),
    );
    const usesTaskRisk =
      decisionUsesTaskRisk(request) ||
      ((request.decisionType === "authority.delegate" ||
        request.decisionType === "authority.revoke") &&
        request.taskId !== undefined);
    const risk = usesTaskRisk
      ? request.taskId === undefined
        ? undefined
        : this.store.getTask(request.taskId)?.risk
      : this.store.getMission(request.missionId)?.intent.risk;
    return {
      ...request,
      context: {
        ...contextWithoutRisk,
        ...(risk === undefined ? {} : { risk }),
      },
    };
  }

  private allow(request: DecisionRequest, reason: string): AuthorizationResult {
    const result: AuthorizationResult = { result: "allow", reason };
    this.recordAuthorization(request, result);
    if (
      request.actorId === "runtime" &&
      request.role === "runtime" &&
      request.decisionType === "state.transition"
    ) {
      genuineRuntimeTransitionAuthorizations.set(result, request);
    }
    if (
      request.decisionType === "task.assign" &&
      typeof request.context?.workerAgentId === "string"
    ) {
      genuineTaskAssignmentAuthorizations.set(result, request);
    }
    return result;
  }

  private deny(
    request: DecisionRequest,
    code: DoctrineViolation["code"],
    message: string,
  ): Extract<AuthorizationResult, { result: "deny" }> {
    return this.recordDeny(request, {
      code,
      actorId: request.actorId,
      decisionType: request.decisionType,
      message,
      createdAt: this.now(),
    });
  }

  private recordDeny(
    request: DecisionRequest,
    violation: DoctrineViolation,
  ): Extract<AuthorizationResult, { result: "deny" }> {
    const record: DoctrineViolationRecord = {
      ...violation,
      id: this.createId(),
      requestId: request.id,
      missionId: request.missionId,
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
    };
    const result = {
      result: "deny" as const,
      reason: violation.message,
      violation,
    };
    const relatedEvents: Event[] = [];
    if (violation.code === "CONSTRAINT_VIOLATION") {
      relatedEvents.push(
        this.event(request.missionId, "ConstraintViolationDetected", "runtime", {
          requestId: request.id,
          violationId: record.id,
        }),
      );
    }
    if (violation.code === "RISK_LIMIT_EXCEEDED") {
      relatedEvents.push(
        this.event(request.missionId, "RiskLimitExceeded", "runtime", {
          requestId: request.id,
          violationId: record.id,
        }),
      );
    }
    this.store.saveDoctrineDenialAudit({
      violation: record,
      violationEvent: this.event(request.missionId, "DoctrineViolationDetected", "runtime", {
        requestId: request.id,
        violationId: record.id,
        code: violation.code,
      }),
      relatedEvents,
      authorization: this.buildAuthorizationAudit(request, result, record),
    });
    return result;
  }

  private denialAuthorizationEvent(
    request: DecisionRequest,
    violation: DoctrineViolation,
    createdAt: Date,
  ): Event {
    return this.event(request.missionId, "AuthorizationDenied", "runtime", {
        requestId: request.id,
        actorId: request.actorId,
        decisionType: request.decisionType,
        violationCode: violation.code,
      }, createdAt);
  }

  private escalateAuthorization(
    request: DecisionRequest,
    targetRole: DoctrineActorRole,
  ): AuthorizationResult {
    const reason = `${request.decisionType} is owned by ${targetRole}`;
    const escalation: EscalationRecord = {
      id: this.createId(),
      missionId: request.missionId,
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
      requesterId: request.actorId,
      decisionType: request.decisionType,
      reason,
      ...(request.context?.requestedChange === undefined
        ? {}
        : { requestedChange: request.context.requestedChange }),
      targetRole: routeEscalation(request.role, request.decisionType),
      createdAt: this.now(),
      status: "open",
    };
    const result: AuthorizationResult = {
      result: "escalate",
      reason,
      escalation: escalation,
    };
    this.store.saveEscalationWithAudit({
      escalation,
      escalationEvent: this.escalationEvent(escalation),
      authorization: this.buildAuthorizationAudit(request, result),
    });
    return result;
  }

  private escalationEvent(escalation: EscalationRecord): Event {
    return this.event(escalation.missionId, "EscalationCreated", "runtime", {
        escalationId: escalation.id,
        requesterId: escalation.requesterId,
        targetRole: escalation.targetRole,
        decisionType: escalation.decisionType,
      });
  }

  private recordAuthorization(
    request: DecisionRequest,
    result: AuthorizationResult,
    violation?: DoctrineViolationRecord,
  ): void {
    const audit = this.buildAuthorizationAudit(request, result, violation);
    this.store.saveAuthorizationRecordAndEvent(audit.record, audit.event);
  }

  private buildAuthorizationAudit(
    request: DecisionRequest,
    result: AuthorizationResult,
    violation?: DoctrineViolationRecord,
  ): AuthorizationAudit {
    const createdAt = this.now();
    const record: AuthorizationRecord = {
      id: this.createId(),
      requestId: request.id,
      missionId: request.missionId,
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
      actorId: request.actorId,
      decisionType: request.decisionType,
      result: result.result,
      reason: result.reason,
      ...(result.result === "escalate"
        ? { targetRole: result.escalation.targetRole }
        : {}),
      ...(violation === undefined ? {} : { violation }),
      createdAt,
    };
    const auditEvent =
      result.result === "allow"
        ? this.event(request.missionId, "AuthorizationAllowed", "runtime", {
            requestId: request.id,
            actorId: request.actorId,
            decisionType: request.decisionType,
            reason: result.reason,
          }, createdAt)
        : result.result === "deny"
          ? this.denialAuthorizationEvent(request, result.violation, createdAt)
          : this.event(request.missionId, "AuthorizationEscalated", "runtime", {
              requestId: request.id,
              escalationId: result.escalation.id,
              targetRole: result.escalation.targetRole,
            }, createdAt);
    return { record, event: auditEvent };
  }

  private delegationAuditRequest(
    request: DelegationRequest,
    role: DoctrineActorRole,
    createdAt: Date,
  ): DecisionRequest {
    return {
      id: this.createId(),
      actorId: request.issuerId,
      role,
      missionId: request.missionId,
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
      decisionType: "authority.delegate",
      action: "authority.delegate",
      resource:
        request.taskId === undefined
          ? { type: "mission", missionId: request.missionId }
          : { type: "task", taskId: request.taskId },
      createdAt,
    };
  }

  private event(
    missionId: string,
    type: string,
    actor: string,
    payload: Event["payload"],
    createdAt = this.now(),
  ): Event {
    return {
      id: this.createId(),
      missionId,
      type,
      actor,
      payload,
      createdAt,
    };
  }
}

function compareGrantProvenance(
  left: AuthorityGrant,
  right: AuthorityGrant,
): number {
  if (left.expiresAt === undefined && right.expiresAt !== undefined) return -1;
  if (left.expiresAt !== undefined && right.expiresAt === undefined) return 1;
  if (left.expiresAt !== undefined && right.expiresAt !== undefined) {
    const latestFirst = right.expiresAt.getTime() - left.expiresAt.getTime();
    if (latestFirst !== 0) return latestFirst;
  }
  return left.id.localeCompare(right.id);
}
