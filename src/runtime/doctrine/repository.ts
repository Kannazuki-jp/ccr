import type {
  AgentRecord,
  AuthorityGrant,
  AuthorizationRecord,
  DoctrineViolationRecord,
  EscalationRecord,
  Event,
  Mission,
  Report,
  Task,
} from "../../domain/index.js";

export interface AuthorizationAudit {
  readonly record: AuthorizationRecord;
  readonly event: Event;
}

export interface AuthorityGrantAudit {
  readonly grant: AuthorityGrant;
  readonly grantEvent: Event;
  readonly constraintEvents: readonly Event[];
  readonly authorization: AuthorizationAudit;
}

export interface AuthorityRevocationAudit {
  readonly grantId: string;
  readonly revokedAt: Date;
  readonly revokeEvent: Event;
  readonly authorization: AuthorizationAudit;
}

export interface EscalationAudit {
  readonly escalation: EscalationRecord;
  readonly escalationEvent: Event;
  readonly authorization: AuthorizationAudit;
}

export interface DoctrineDenialAudit {
  readonly violation: DoctrineViolationRecord;
  readonly violationEvent: Event;
  readonly relatedEvents: readonly Event[];
  readonly authorization: AuthorizationAudit;
}

/** Doctrine enforcementが必要とするappend-only永続化境界。 */
export interface DoctrineStore {
  getAgent(id: string): AgentRecord | undefined;
  getMission(id: string): Mission | undefined;
  getTask(id: string): Task | undefined;
  listTasks(missionId?: string): Task[];
  getEscalation(id: string): EscalationRecord | undefined;
  listReports(missionId?: string, taskId?: string): Report[];
  listEvents(missionId?: string): Event[];
  getAuthorityGrant(id: string): AuthorityGrant | undefined;
  listAuthorityGrants(
    missionId: string,
    subjectId?: string,
  ): AuthorityGrant[];
  grantAuthority(grant: AuthorityGrant, event: Event): void;
  grantAuthorityWithAudit(input: AuthorityGrantAudit): void;
  revokeAuthorityGrant(
    grantId: string,
    revokedAt: Date,
    event: Event,
  ): AuthorityGrant;
  revokeAuthorityGrantWithAudit(
    input: AuthorityRevocationAudit,
  ): AuthorityGrant;
  expireAuthorityGrant(grantId: string, event: Event): AuthorityGrant;
  saveEscalationAndEvent(escalation: EscalationRecord, event: Event): void;
  saveEscalationWithAudit(input: EscalationAudit): void;
  saveAuthorizationRecordAndEvent(
    record: AuthorizationRecord,
    event: Event,
  ): void;
  saveDoctrineViolationAndEvent(
    violation: DoctrineViolationRecord,
    event: Event,
  ): void;
  saveDoctrineDenialAudit(input: DoctrineDenialAudit): void;
  appendEvent(event: Event): void;
}
