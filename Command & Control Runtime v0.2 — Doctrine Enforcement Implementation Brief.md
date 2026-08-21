# Command & Control Runtime v0.2 — Doctrine Enforcement Implementation Brief

## 1. この文書の目的

本ドキュメントは、**Command & Control Runtime Prototype v0.1** に対して、確定したDecision Rights DoctrineをRuntimeレベルで強制するための **v0.2 Doctrine Enforcement** の実装仕様を定義する。

v0.1では、

```text
Goal
  ↓
Mission
  ↓
Task
  ↓
Execute
  ↓
Evaluate
  ↓
Replan / Complete
```

という最小のC2ループを成立させた。

v0.2では、このC2ループ上の判断・委譲・実行・評価・状態変更が、Doctrineで定義したCommand Boundaryから逸脱しないことをRuntimeが保証する。

v0.2の目的は、

> **AgentにDoctrineを「守るよう依頼する」のではなく、重要なDoctrineをRuntimeによって「破れないInvariant」にすること**

である。

---

# 2. 前提

v0.2はv0.1の置き換えではない。

```text
v0.1
C2 Execution Loop
        +
v0.2
Doctrine Enforcement
        =
Controlled C2 Runtime
```

v0.1で既に存在する以下の概念を維持する。

* Human
* Commander
* Lead
* Worker
* Evaluator
* Runtime
* Goal
* Mission
* Task
* Report
* Evaluation
* Decision
* Event
* State Machine
* Escalation
* Replanning
* SQLite Persistence
* Structured Output Validation

v0.2では主に以下を追加する。

* Authority Model
* Permission Model
* Resource Scope
* Delegation
* Constraint
* Risk Limit
* Effective Authority Resolution
* Decision Request
* Authorization Decision
* Command Boundary Enforcement
* Escalation Routing
* Authority Revocation
* Doctrine Compliance Tests

---

# 3. Normative Doctrine

v0.2の実装は、

```text
.agents/doctrine/decision-rights.md
```

を規範となるDoctrineとして扱う。

実装AIはDoctrineの意味を独自に変更しないこと。

Doctrineと実装上の都合が衝突した場合、

```text
Doctrine
   >
Implementation convenience
```

とする。

ただしDoctrineに実装上必要な情報が存在しない場合は、Doctrineそのものを勝手に拡張せず、最小限の技術的実装を選択する。

---

# 4. v0.2 Core Principle

システム全体の中心原則：

```text
Agent decides.
Runtime controls.
```

責務を以下のように分離する。

```text
Human / Agent
    │
    │ proposes decision / action
    ▼
┌──────────────────────────┐
│       C2 Runtime         │
│                          │
│ Schema Validation        │
│ Command Boundary Check   │
│ Authority Resolution     │
│ Constraint Check         │
│ Risk Check               │
│ State Check              │
│ Delegation Validation    │
└────────────┬─────────────┘
             │
       ┌─────┼─────┐
       ▼     ▼     ▼
     ALLOW  DENY ESCALATE
```

Runtimeは判断内容そのものを考えない。

Runtimeは、

> **その主体が、その判断を、その状況で行う権限を持っているか**

だけを決定論的に判定する。

---

# 5. Command Boundaries

v0.2では以下のBoundaryをRuntimeが認識する。

## Human Boundary

Humanが所有する。

```text
Goal
Strategic Constraints
Strategic Boundary
Final high-impact decisions
```

Commander以下はGoalを変更できない。

---

## Commander Boundary

Commanderが所有する。

```text
Mission
Mission Purpose
Commander's Intent
Desired End State
Mission Priority
Mission Constraints
Mission Success Criteria
Mission Scope
Mission-level Authority Boundary
```

Commanderは原則としてHOWを所有しない。

---

## Lead Boundary

Leadが所有する。

```text
Plan
Task decomposition
Task creation / replacement / removal
Task Objective
Task Success Criteria
Task Dependencies
Task Assignment
Task Ordering
Worker Context
Worker Delegation
Task / Mission Plan Replanning
```

LeadはGoalやMission Purposeを独自に変更できない。

---

## Worker Boundary

Workerが所有する。

```text
HOW
Implementation method
Algorithm
Tool selection
Local procedure
Local retry
Local adaptation
Task result
Structured report
```

WorkerはTask / Authority / Constraintsの範囲内では追加承認を必要としない。

---

## Evaluator Boundary

EvaluatorはCommand Chainから独立したAssessment機能である。

所有する判断：

```text
Evidence inspection
Success Criteria assessment
PASS / FAIL
retry / replan / escalate / fail recommendation
```

EvaluatorはStateを直接変更できない。

---

## Runtime Boundary

RuntimeはEnforcement Authorityのみを持つ。

```text
Validation
Authorization
Constraint enforcement
State transition
Event persistence
Decision persistence
Escalation routing
```

Runtimeは以下を生成・変更しない。

```text
Goal
Mission Purpose
Plan
Task Objective
HOW
```

---

# 6. v0.2 Scope

## 実装する

* Permission Model
* Authority Model
* Authority Grant
* Delegation
* Authority Revocation
* Resource Scope
* Constraint Model
* Risk Limit Model
* Effective Authority Resolution
* Decision Request
* Authorization Result
* Command Boundary Check
* Authority Check
* Constraint Check
* Risk Check
* Delegation Validation
* Escalation Routing
* Runtime Enforcement API
* Doctrine-specific Events
* Doctrine Compliance Tests
* v0.1 integration

---

## 実装しない

v0.2では以下へ拡張しない。

* 複数Worker並列実行
* 複数Lead
* Staff Agents
* 動的なCommand Chain
* Agent間P2P通信
* Message Bus
* Kafka
* Redis
* Temporal
* Distributed Runtime
* Graph DB
* Long-term Memory
* 複雑なRBAC製品相当の機能
* Policy DSL
* 独自Rule Engine
* Web管理画面
* Multi-tenant Authority

v0.2の目的は、

> **Doctrine Enforcementが成立すること**

であり、汎用Authorization Platformを作ることではない。

---

# 7. Decision Right Types

Doctrine上のDecision RightをRuntime内で表現可能にする。

```ts
type DecisionRight =
  | "owner"
  | "delegated"
  | "propose"
  | "verify"
  | "enforce"
  | "none"
```

意味：

| Right       | 意味                |
| ----------- | ----------------- |
| `owner`     | 正式なDecision Owner |
| `delegated` | 上位から委譲された範囲で判断可能  |
| `propose`   | 提案のみ可能            |
| `verify`    | 独立評価可能            |
| `enforce`   | Runtimeが機械的に強制    |
| `none`      | 判断権限なし            |

---

# 8. Decision Type

RuntimeがCommand Boundaryを判定するには、判断を分類する必要がある。

最低限以下を定義する。

```ts
type DecisionType =
  // Human
  | "goal.create"
  | "goal.modify"
  | "strategic_constraint.modify"

  // Commander
  | "mission.create"
  | "mission.purpose.modify"
  | "mission.intent.modify"
  | "mission.end_state.modify"
  | "mission.priority.modify"
  | "mission.constraint.modify"
  | "mission.success_criteria.modify"
  | "mission.scope.modify"
  | "mission.cancel"

  // Lead
  | "task.create"
  | "task.modify"
  | "task.remove"
  | "task.assign"
  | "task.reorder"
  | "task.constraint.modify"
  | "task.success_criteria.modify"
  | "plan.modify"
  | "authority.delegate"

  // Worker
  | "execution.method.select"
  | "execution.tool.select"
  | "execution.local_change"
  | "execution.retry"
  | "execution.procedure.modify"
  | "report.submit"

  // Evaluator
  | "evaluation.verify"
  | "evaluation.pass"
  | "evaluation.fail"
  | "evaluation.recommend"

  // Runtime
  | "state.transition"
  | "authority.revoke"
```

初期実装では必要以上に細分化しない。

---

# 9. Permission Model

Permissionは、

> **誰が、何に対して、何を行えるか**

を表す。

```ts
type Permission = {
  action: string
  resource: ResourceScope
}
```

例：

```ts
const permission = {
  action: "code.edit",
  resource: {
    type: "path",
    pattern: "src/auth/**"
  }
}
```

---

# 10. Resource Scope

AuthorityをBooleanだけで表現しない。

例えば、

```text
code_edit = true
```

ではなく、

```text
code_edit
対象 = src/auth/**
```

まで表現可能にする。

概念例：

```ts
type ResourceScope =
  | {
      type: "global"
    }
  | {
      type: "mission"
      missionId: string
    }
  | {
      type: "task"
      taskId: string
    }
  | {
      type: "path"
      pattern: string
    }
  | {
      type: "tool"
      tool: string
    }
  | {
      type: "custom"
      key: string
      value: string
    }
```

Prototypeでは複雑なPattern Engineを作らない。

必要なScopeだけ実装する。

---

# 11. Authority

AuthorityはAgentが保有する意思決定・行動権限を表す。

```ts
type Authority = {
  subjectId: string
  permissions: Permission[]
  constraints: Constraint[]
  riskLimits: RiskLimit[]
}
```

Authorityは少なくとも2種類存在する。

```text
Role Authority
Mission Delegation
```

---

# 12. Role Authority

Role Authorityは、そのRoleが通常持つ最大権限を定義する。

例：

```yaml
worker:
  allowed:
    - code.read
    - code.edit
    - tool.select
    - test.run

  prohibited:
    - goal.modify
    - mission.purpose.modify
    - production.delete
```

Role Authorityは、

> **そのRoleだから必ず行使できる権限**

ではなく、

> **そのRoleに委譲可能な最大範囲**

として扱う。

Mission Constraint等によってさらに狭くなる。

---

# 13. Authority Grant

DelegationされたAuthorityを明示的なDomain Objectとして持つ。

```ts
type AuthorityGrant = {
  id: string

  issuerId: string
  subjectId: string

  missionId: string
  taskId?: string

  permissions: Permission[]
  constraints: Constraint[]
  riskLimits: RiskLimit[]

  status:
    | "active"
    | "revoked"
    | "expired"

  createdAt: Date
  expiresAt?: Date
  revokedAt?: Date
}
```

Authority GrantはRuntime Stateとして保存する。

---

# 14. Delegation Rules

Runtimeは以下をInvariantとして強制する。

## Rule 1 — No Authority Creation

```text
DelegatedAuthority(child)
⊆
EffectiveAuthority(parent)
```

Agentは自身が持たないAuthorityを下位へ作り出せない。

例：

```text
Commander
production.deploy = prohibited

        ↓

Leadへproduction.deployを委譲

        ↓

DENY
```

---

## Rule 2 — Delegation May Narrow

上位AgentはAuthorityを狭めて委譲できる。

```text
Parent:
code.edit = repository/**

Child:
code.edit = src/auth/**

→ ALLOW
```

逆は許可しない。

---

## Rule 3 — Higher Constraints Survive Delegation

上位ConstraintはDelegationによって解除できない。

```text
Commander Constraint:
public_api_change = prohibited

Lead delegates:
public_api_change = allowed

→ DENY
```

---

## Rule 4 — Command Ownership Does Not Transfer

Authorityを委譲しても、

```text
Goal Ownership
Mission Purpose Ownership
Commander's Intent Ownership
```

は移転しない。

例えばCommanderがLeadに広い実装権限を与えても、

```text
Lead → Mission Purpose変更
```

は許可されない。

---

## Rule 5 — Delegation Is Revocable

上位Agentは自身が発行したAuthority Grantを縮小・失効できる。

RevocationはEventとして記録する。

---

# 15. Constraint Model

Constraintを文字列だけで扱うのではなく、Runtimeが判定可能なものは構造化する。

```ts
type Constraint = {
  id: string
  sourceId: string

  kind:
    | "prohibit"
    | "require"
    | "limit"

  target: string

  scope?: ResourceScope

  value?: unknown

  inherited: boolean
}
```

例：

```ts
{
  id: "c1",
  sourceId: "commander",
  kind: "prohibit",
  target: "public_api.modify",
  inherited: true
}
```

---

# 16. Constraint Inheritance

上位のConstraintは下位へ継承する。

```text
Human Constraint
       ↓
Commander Constraint
       ↓
Lead Constraint
       ↓
Worker Constraint
```

Runtimeは下位AgentがInherited Constraintを解除・緩和することを拒否する。

下位Agentが追加のConstraintを設定して、さらに権限を狭めることは許可できる。

つまり：

```text
constraint_child
>=
constraint_parent
```

安全側へ狭めることは可能。

上位Constraintを弱めることは不可。

---

# 17. Risk Limit

DoctrineにおけるEffective AuthorityにはRisk Limitsも含まれる。

最低限のDomain Modelを定義する。

```ts
type RiskLimit = {
  dimension: string

  operator:
    | "lt"
    | "lte"
    | "eq"

  value: number
}
```

例：

```ts
{
  dimension: "cost",
  operator: "lte",
  value: 1000
}
```

または、

```ts
{
  dimension: "retry_count",
  operator: "lte",
  value: 3
}
```

v0.2ではRisk Engineを作らない。

Runtimeが決定論的に評価可能な数値Limitだけでよい。

---

# 18. Effective Authority

Doctrine上の式：

```text
Effective Authority
=
Role Authority
∩
Mission Delegation
∩
Current Constraints
∩
Risk Limits
```

をRuntimeで実装する。

概念的には、

```ts
resolveEffectiveAuthority(
  actor,
  mission,
  task,
  currentState
): EffectiveAuthority
```

とする。

処理順：

```text
1. Role Authorityを取得
        ↓
2. Active Authority Grantsを取得
        ↓
3. 対象Mission / Task Scopeへ限定
        ↓
4. Inherited Constraintsを適用
        ↓
5. Risk Limitsを適用
        ↓
6. Revoked / Expired Grantを除外
        ↓
7. Effective Authorityを返す
```

---

# 19. Decision Request

Agentの重要な判断・操作は、RuntimeへDecision Requestとして提出する。

```ts
type DecisionRequest = {
  id: string

  actorId: string
  role: AgentRole

  missionId: string
  taskId?: string

  decisionType: DecisionType

  action: string
  resource?: ResourceScope

  context?: Record<string, unknown>

  createdAt: Date
}
```

Agentは直接System Stateを書き換えない。

```text
Agent
  ↓
DecisionRequest
  ↓
Runtime
```

とする。

---

# 20. Authorization Result

RuntimeのDoctrine Enforcement結果を共通Contractにする。

```ts
type AuthorizationResult =
  | {
      result: "allow"
      reason: string
    }
  | {
      result: "deny"
      reason: string
      violation: DoctrineViolation
    }
  | {
      result: "escalate"
      reason: string
      escalation: EscalationRequest
    }
```

---

# 21. ALLOW / DENY / ESCALATE

Runtimeの判断は原則3種類とする。

## ALLOW

現在のAgentがその判断のOwnerまたはDelegated Authorityを持ち、Constraint / Risk / Stateにも違反していない。

```text
→ 実行可能
```

---

## DENY

Doctrine上、明確に禁止されている。

例：

```text
Worker
→ Goal変更
```

```text
Evaluator
→ Task stateをcompletedへ変更
```

```text
Lead
→ 親より大きなAuthorityをWorkerへ委譲
```

---

## ESCALATE

操作自体が不正なのではなく、

> **現在のAgentのCommand Boundaryを越えるDecision Ownerの判断が必要**

な場合。

例：

```text
Worker:
Mission Scope変更が必要

→ ESCALATE TO Lead / Commander
```

---

# 22. DENYとESCALATEを区別する

これは重要な実装要件である。

### DENY

```text
その行動そのものがDoctrineに反する
```

例：

```text
WorkerがGoalを勝手に書き換える
```

---

### ESCALATE

```text
要求自体は正当だが
現在のActorには決定権がない
```

例：

```text
Worker:
「Task達成にはMission Scope変更が必要」
```

WorkerがMission Scopeを直接変更することはDENY。

しかし、

```text
Mission Scope変更をCommanderへ要求する
```

ことはALLOWされる。

---

# 23. Command Boundary Registry

RuntimeがDecision Ownerを判定できるように、Decision TypeとOwner Roleの対応をコードとして持つ。

概念例：

```ts
const commandBoundaries = {
  "goal.modify": "human",

  "mission.purpose.modify": "commander",
  "mission.scope.modify": "commander",

  "task.create": "lead",
  "task.assign": "lead",
  "plan.modify": "lead",

  "execution.method.select": "worker",
  "execution.tool.select": "worker",

  "evaluation.pass": "evaluator",
  "evaluation.fail": "evaluator",

  "state.transition": "runtime",
}
```

Markdownファイルを毎回Runtimeで自然言語解釈する構造にはしない。

Doctrineを元に、Runtime側へ明示的なContractとして実装する。

---

# 24. Runtime Enforcement Pipeline

全Decision Requestを以下の順で処理する。

```text
DecisionRequest
      ↓
① Schema Validation
      ↓
② Actor / Role Validation
      ↓
③ Current State Validation
      ↓
④ Command Boundary Resolution
      ↓
⑤ Effective Authority Resolution
      ↓
⑥ Constraint Validation
      ↓
⑦ Risk Limit Validation
      ↓
⑧ Authorization Decision
      ↓
┌──────────┬─────────┬────────────┐
│ ALLOW    │ DENY    │ ESCALATE   │
└──────────┴─────────┴────────────┘
      ↓
Event / Decision Log
```

---

# 25. Runtime API

最低限以下のAPIを持たせる。

```ts
interface DoctrineEnforcer {
  authorize(
    request: DecisionRequest
  ): Promise<AuthorizationResult>

  resolveEffectiveAuthority(
    actorId: string,
    context: AuthorityContext
  ): Promise<EffectiveAuthority>

  delegate(
    request: DelegationRequest
  ): Promise<DelegationResult>

  revoke(
    request: RevocationRequest
  ): Promise<RevocationResult>

  escalate(
    request: EscalationRequest
  ): Promise<EscalationResult>
}
```

---

# 26. Delegation Request

```ts
type DelegationRequest = {
  issuerId: string
  subjectId: string

  missionId: string
  taskId?: string

  permissions: Permission[]
  constraints: Constraint[]
  riskLimits: RiskLimit[]

  expiresAt?: Date
}
```

RuntimeはDelegation前に必ず、

```text
requested authority
⊆
issuer effective authority
```

を確認する。

---

# 27. Revocation

Authority Grantは取り消し可能でなければならない。

```ts
type RevocationRequest = {
  actorId: string
  grantId: string
  reason: string
}
```

Runtimeは以下を確認する。

* Grantが存在する
* Grantがactive
* Actorにrevocation authorityがある
* ActorがそのGrantを取り消せる位置にいる

成功時：

```text
active
  ↓
revoked
```

AuthorityRevoked Eventを記録する。

---

# 28. Escalation Request

```ts
type EscalationRequest = {
  id: string

  missionId: string
  taskId?: string

  requesterId: string

  decisionType: DecisionType

  reason: string

  requestedChange?: unknown

  targetRole: AgentRole

  createdAt: Date
}
```

---

# 29. Escalation Routing

Escalation先は単純に「一つ上」ではなく、

> **そのDecision TypeのOwnerまたは解決可能な最も近い権限主体**

へ送る。

基本例：

```text
Worker
  │
  │ Task Plan変更
  ▼
Lead

Worker
  │
  │ Mission Scope変更
  ▼
Lead
  │ cannot resolve
  ▼
Commander

Lead
  │
  │ Goal変更
  ▼
Commander
  │ cannot resolve
  ▼
Human
```

Prototypeでは固定Command Chain：

```text
Worker
→ Lead
→ Commander
→ Human
```

を利用してよい。

---

# 30. Lowest Competent Authority

Doctrineの

> 意思決定は必要なAuthority・Context・Competenceを持つ最も低い階層で行う

という原則を維持する。

ただしv0.2では **Competenceを高度な動的スコアリングとして実装しない**。

Prototypeでは、

```text
Competence
≈ Role capability / Agent assignment validity
```

程度に限定する。

つまり、

* WorkerとしてTaskへ割り当てられている
* 必要なRole Capabilityを持つ
* Authorityを持つ

ならCompetentとみなしてよい。

高度なAgent capability scoringは将来スコープとする。

---

# 31. Bounded Autonomy Enforcement

Doctrine：

```text
Autonomy
=
Intent
+ Authority
+ Constraints
```

WorkerはこのBoundary内なら追加承認なしで行動可能でなければならない。

つまりRuntimeは、

```text
安全のため全部Commander承認
```

という実装にしてはならない。

Doctrine Enforcementは、

> **自律性を減らすためではなく、安全に自律性を成立させるため**

に存在する。

---

# 32. Evaluator Isolation

Evaluatorは独立Assessment機能であり、Command Authorityを持たない。

以下をRuntimeで保証する。

```text
Evaluator
→ Evaluation作成         ALLOW

Evaluator
→ PASS / FAIL判断        ALLOW

Evaluator
→ retry推奨              ALLOW

Evaluator
→ Task.status変更        DENY

Evaluator
→ Mission Scope変更      DENY

Evaluator
→ WorkerへTask指示       DENY
```

Evaluation後のState TransitionはRuntimeが担当する。

---

# 33. Evidence-based Completion

以下のInvariantを維持する。

```text
Worker says completed
        ≠
Task completed
```

正しい流れ：

```text
Worker Execution
      ↓
Task Result
      ↓
Evidence
      ↓
Evaluator
      ↓
PASS
      ↓
Runtime Validation
      ↓
State Transition
      ↓
Task Completed
```

RuntimeはEvaluatorのResultなしでTaskをcompletedへ遷移させてはならない。

例外が必要なら明示的なHuman Overrideとして別途設計する。

v0.2ではOverride機能は必須ではない。

---

# 34. Replanning Enforcement

Replanning Authorityは変更対象Boundaryに応じて異なる。

```text
Worker
→ HOW変更

Lead
→ Task / Plan変更

Commander
→ Mission Scope / Intent変更

Human
→ Goal / Strategic Boundary変更
```

Runtimeは変更内容からDecision Typeを判定し、そのOwnerを確認する。

例：

```text
Worker requests:
execution.method.select
→ ALLOW

Worker requests:
task.create
→ ESCALATE / DENY direct mutation

Lead requests:
task.create
→ ALLOW

Lead requests:
mission.purpose.modify
→ ESCALATE

Commander requests:
goal.modify
→ ESCALATE
```

---

# 35. State Machine Integration

Doctrine Enforcementは既存State Machineの前段に配置する。

```text
Decision
   ↓
Doctrine Enforcement
   ↓ ALLOW
State Machine Validation
   ↓
State Transition
```

つまり、

```text
Authority OK
```

でも、

```text
completed → running
```

のようなInvalid Transitionなら拒否する。

逆に、

```text
State transition valid
```

でもActorにAuthorityがなければ拒否する。

両方を満たす必要がある。

---

# 36. Doctrine Violation

Doctrine違反を通常の例外文字列だけで処理しない。

```ts
type DoctrineViolation = {
  code:
    | "COMMAND_BOUNDARY_VIOLATION"
    | "INSUFFICIENT_AUTHORITY"
    | "CONSTRAINT_VIOLATION"
    | "RISK_LIMIT_EXCEEDED"
    | "INVALID_DELEGATION"
    | "REVOKED_AUTHORITY"
    | "EXPIRED_AUTHORITY"
    | "EVALUATOR_STATE_MUTATION"
    | "INVALID_STATE_TRANSITION"

  actorId: string
  decisionType: DecisionType

  message: string

  createdAt: Date
}
```

---

# 37. Event Model Extension

v0.1のEvent Logへ以下を追加する。

```text
AuthorityGranted
AuthorityRevoked
AuthorityExpired

DecisionRequested

AuthorizationAllowed
AuthorizationDenied
AuthorizationEscalated

ConstraintApplied
ConstraintViolationDetected

RiskLimitExceeded

EscalationCreated
EscalationResolved

DoctrineViolationDetected
```

すべてappend-onlyで記録する。

---

# 38. Decision Log

RuntimeによるAuthorization結果もDecision Logへ残す。

例：

```json
{
  "actor": "worker-01",
  "decisionType": "mission.scope.modify",
  "result": "escalate",
  "reason": "Mission Scope is owned by Commander",
  "targetRole": "commander"
}
```

これにより、

> なぜ実行できなかったか

を後から追跡可能にする。

---

# 39. Persistence

v0.1のSQLiteを継続使用する。

追加候補：

```text
authority_grants
constraints
risk_limits
escalations
```

既存：

```text
missions
tasks
agents
reports
decisions
events
```

---

## authority_grants

最低限：

```text
id
issuer_id
subject_id
mission_id
task_id
permissions_json
constraints_json
risk_limits_json
status
created_at
expires_at
revoked_at
```

PrototypeではJSON列を利用してもよい。

高度なNormalizationは不要。

---

# 40. Repository Structure

既存構造へ以下を追加する。

```text
src/
├── domain/
│   ├── authority.*
│   ├── permission.*
│   ├── constraint.*
│   ├── risk-limit.*
│   ├── decision-request.*
│   ├── authorization-result.*
│   ├── escalation.*
│   └── doctrine-violation.*
│
├── runtime/
│   ├── doctrine/
│   │   ├── enforcer.*
│   │   ├── authority-resolver.*
│   │   ├── boundary-registry.*
│   │   ├── constraint-checker.*
│   │   ├── risk-checker.*
│   │   ├── delegation-validator.*
│   │   └── escalation-router.*
│   │
│   ├── state-machine.*
│   └── runtime.*
│
├── storage/
│   └── sqlite/
│       ├── authority-repository.*
│       ├── escalation-repository.*
│       └── ...
│
└── agents/
```

Tests：

```text
tests/
├── unit/
├── integration/
└── doctrine/
    ├── command-boundary.*
    ├── delegation.*
    ├── constraints.*
    ├── authority.*
    ├── escalation.*
    ├── evaluation-isolation.*
    └── replanning.*
```

---

# 41. Implementation Order

以下の順で実装する。

## Phase 1 — Doctrine Contract

実装：

* DecisionType
* DecisionRight
* Permission
* ResourceScope
* Command Boundary Registry

完成条件：

```text
Decision Type
→ Owner Role
```

を決定論的に取得できる。

---

## Phase 2 — Authority Domain

実装：

* Authority
* Role Authority
* AuthorityGrant
* Constraint
* RiskLimit

この段階ではAgentやLLMを変更しない。

---

## Phase 3 — Effective Authority Resolver

実装：

```text
Role Authority
∩
Mission Delegation
∩
Constraints
∩
Risk Limits
```

テストを先に作る。

---

## Phase 4 — Delegation Enforcement

実装：

* DelegationRequest
* delegation validation
* AuthorityGrant persistence
* No Authority Creation
* Constraint inheritance
* narrowing
* expiration

---

## Phase 5 — Revocation

実装：

* AuthorityRevoked
* revoked authority rejection
* persistence

---

## Phase 6 — Decision Request

AgentからRuntimeへの重要操作をDecisionRequest経由に変更する。

既存Agent Interfaceそのものを必要以上に破壊しない。

---

## Phase 7 — Doctrine Enforcer

実装：

```ts
authorize(request)
```

が、

```text
ALLOW
DENY
ESCALATE
```

を返す。

---

## Phase 8 — Command Boundary Enforcement

以下の境界を実装する。

```text
Human      → Goal
Commander  → Mission
Lead       → Plan / Task
Worker     → HOW
Evaluator  → Assessment
Runtime    → State
```

---

## Phase 9 — Escalation Router

Decision Typeから適切な上位Decision Ownerを決定する。

EscalationをEvent / DBへ保存する。

---

## Phase 10 — Evaluator Isolation

Evaluatorが状態を直接変更できないことをRuntimeで強制する。

---

## Phase 11 — State Machine Integration

Doctrine authorization通過後だけState Machineへ操作を渡す。

---

## Phase 12 — Doctrine Compliance Tests

Doctrineの主要Invariantを自動テスト化する。

---

## Phase 13 — E2E Integration

実MissionをMock Agentsまたは既存LLM Agentsで流し、

```text
Command
→ Delegation
→ Execution
→ Evaluation
→ Replan / Escalation
```

まで確認する。

---

# 42. Doctrine Compliance Tests

最低限以下を実装する。

## Command Boundaries

* [ ] Commander cannot directly modify Goal
* [ ] Lead cannot modify Mission Purpose
* [ ] Worker cannot modify Mission Scope
* [ ] Worker cannot create Mission
* [ ] Worker may select implementation method
* [ ] Worker may select Tool when allowed
* [ ] Lead may create Tasks
* [ ] Lead may replan Tasks
* [ ] Commander may modify Mission Scope
* [ ] Human may modify Goal

---

## Delegation

* [ ] Child authority cannot exceed parent Effective Authority
* [ ] Parent may delegate a narrower scope
* [ ] Parent may not delegate prohibited permission
* [ ] Higher Constraint survives delegation
* [ ] Delegation does not transfer Goal ownership
* [ ] Delegated Authority may be revoked
* [ ] Revoked Authority cannot be exercised
* [ ] Expired Authority cannot be exercised

---

## Constraints

* [ ] Worker cannot override inherited Constraint
* [ ] Lead cannot relax Commander Constraint
* [ ] Child may add stricter Constraint
* [ ] Constraint violation results in DENY

---

## Escalation

* [ ] Worker needing Task Plan change escalates to Lead
* [ ] Worker needing Mission Scope change reaches Commander
* [ ] Lead needing Goal change reaches Human
* [ ] Escalation does not mutate upper-level state automatically
* [ ] Escalation is persisted

---

## Evaluator

* [ ] Evaluator may PASS
* [ ] Evaluator may FAIL
* [ ] Evaluator may recommend retry
* [ ] Evaluator cannot modify Task state
* [ ] Evaluator cannot modify Mission scope
* [ ] PASS alone does not directly mutate state

---

## Runtime

* [ ] Runtime rejects invalid DecisionRequest
* [ ] Runtime records ALLOW
* [ ] Runtime records DENY
* [ ] Runtime records ESCALATE
* [ ] Runtime rejects invalid State Transition
* [ ] Runtime alone performs protected State Transition

---

# 43. Required Integration Scenarios

単純なUnit Testだけでなく、以下のScenario Testを作る。

## Scenario A — Normal Autonomous Execution

```text
Human
→ Goal

Commander
→ Mission

Lead
→ Task + Worker Authority

Worker
→ Tool selection
→ Implementation
→ Local Retry

Evaluator
→ PASS

Runtime
→ Complete
```

期待：

```text
不要なEscalationなし
```

Mission Command型のBounded Autonomyが成立すること。

---

## Scenario B — Worker Crosses Task Boundary

WorkerがTask Plan変更を必要とする。

期待：

```text
Worker
→ ESCALATE
→ Lead
```

WorkerがTask Planを直接変更しない。

---

## Scenario C — Mission Scope Change

WorkerがMission Scope変更の必要性を発見。

```text
Worker
→ Lead
→ Commander
```

CommanderがDecision Ownerとして判断する。

---

## Scenario D — Goal Change Required

LeadまたはCommanderがGoal自体に問題を発見。

期待：

```text
→ Human Escalation
```

CommanderがGoalを勝手に変更しない。

---

## Scenario E — Invalid Delegation

LeadのEffective Authorityに存在しないPermissionをWorkerへ委譲する。

期待：

```text
DENY
INVALID_DELEGATION
```

---

## Scenario F — Constraint Inheritance

Commander：

```text
public_api.modify = prohibited
```

LeadがWorkerへ：

```text
public_api.modify = allowed
```

を委譲しようとする。

期待：

```text
DENY
CONSTRAINT_VIOLATION
```

---

## Scenario G — Authority Revocation

```text
Lead
→ Worker Authority Grant

Worker
→ operation ALLOW

Lead
→ revoke

Worker
→ same operation
```

期待：

```text
DENY
REVOKED_AUTHORITY
```

---

## Scenario H — Evaluator Isolation

EvaluatorがPASS後に直接、

```text
task.status = completed
```

を変更しようとする。

期待：

```text
DENY
```

Runtimeが正規のState Transitionを実行する場合のみ成功する。

---

# 44. v0.2 Acceptance Criteria

以下をすべて満たした時点で **Command & Control Runtime v0.2 — Doctrine Enforcement** を完成とする。

## Authority

* [ ] Role Authorityを表現できる
* [ ] Mission Delegationを表現できる
* [ ] Effective Authorityを算出できる
* [ ] Resource Scopeを扱える
* [ ] Risk Limitを扱える

## Delegation

* [ ] Authorityを下位Agentへ委譲できる
* [ ] 親より広いAuthorityの委譲を拒否できる
* [ ] Authority Scopeを狭めて委譲できる
* [ ] Delegated Authorityを取り消せる
* [ ] Expirationを扱える
* [ ] ConstraintがDelegationを超えて継承される

## Command Boundary

* [ ] Goal OwnershipをRuntimeが強制できる
* [ ] Mission OwnershipをRuntimeが強制できる
* [ ] Planning OwnershipをRuntimeが強制できる
* [ ] Execution OwnershipをRuntimeが強制できる
* [ ] Evaluation BoundaryをRuntimeが強制できる

## Authorization

* [ ] DecisionRequestを受け取れる
* [ ] `ALLOW`を返せる
* [ ] `DENY`を返せる
* [ ] `ESCALATE`を返せる
* [ ] DENYとESCALATEを区別できる

## Escalation

* [ ] Decision Typeから適切な上位Ownerを特定できる
* [ ] Escalation Requestを作成できる
* [ ] Escalationを永続化できる
* [ ] Escalation先でのみ上位Boundary変更が可能

## Evaluation

* [ ] Evaluatorが独立評価できる
* [ ] EvaluatorがStateを直接変更できない
* [ ] PASS後のState TransitionをRuntimeのみが行える

## State

* [ ] Authority CheckとState Machineの両方を通過しなければ状態変更できない
* [ ] Invalid Transitionを拒否できる

## Auditability

* [ ] AuthorityGrantを記録できる
* [ ] AuthorityRevocationを記録できる
* [ ] Authorization結果を記録できる
* [ ] DoctrineViolationを記録できる
* [ ] Escalationを記録できる

## Tests

* [ ] Doctrine Compliance Testsが存在する
* [ ] Command Boundary testsが通る
* [ ] Delegation testsが通る
* [ ] Constraint testsが通る
* [ ] Escalation testsが通る
* [ ] Evaluator Isolation testsが通る
* [ ] E2E Scenario testsが通る

---

# 45. Completion Definition

v0.2の完成とは、

```text
AgentがDoctrineを理解している
```

ことではない。

完成条件は、

```text
AgentがDoctrineに反するDecisionを出しても
Runtimeが正しく
ALLOW / DENY / ESCALATE
できる
```

ことである。

---

# 46. v0.2で避けるべき設計

以下を避けること。

## Prompt-only Enforcement

```text
System Prompt:
「Goalを変更しないでください」
```

だけで済ませない。

重要なBoundaryはRuntimeでも検証する。

---

## Everything Requires Approval

安全のために全DecisionをCommander / HumanへEscalateしない。

これはMission Command Doctrineに反する。

Authority内では下位Agentが自律判断する。

---

## Role-only Authorization

```text
Workerだから許可
```

だけで判定しない。

Effective Authorityを使う。

---

## LLM-based Authorization

「この操作は許可されると思いますか？」をLLMに判断させない。

Authority / Constraint / Stateの判定は可能な限り決定論的コードで行う。

---

## Doctrine Parsing at Runtime

毎回Markdown DoctrineをLLMに読ませてAuthorityを判断しない。

Doctrineは設計上のSource of Truthとし、Runtimeでは明示的なContract / Registry / Modelへ落とす。

---

## Premature Generalization

汎用Policy Engineや巨大RBAC Frameworkへ発展させない。

v0.2のAcceptance Criteriaを満たす最小構造を優先する。

---

# 47. Implementation Priority

実装AIは以下の優先順位で進める。

```text
1. Decision / Boundary Contract
       ↓
2. Authority Domain Model
       ↓
3. Effective Authority Resolver
       ↓
4. Delegation Validation
       ↓
5. Runtime Authorize()
       ↓
6. Command Boundary Enforcement
       ↓
7. Escalation Routing
       ↓
8. Evaluator Isolation
       ↓
9. State Machine Integration
       ↓
10. Persistence / Events
       ↓
11. Doctrine Compliance Tests
       ↓
12. E2E Test
```

LLM Agentの改善はv0.2の主目的ではない。

---

# 48. First Milestone

最初に通すべきテストは、LLMなしで以下を検証する。

```ts
const result = await enforcer.authorize({
  actorId: "worker-01",
  role: "worker",
  missionId: "mission-01",
  decisionType: "mission.scope.modify",
  action: "modify",
})

expect(result.result).toBe("escalate")
expect(result.escalation.targetRole).toBe("commander")
```

次に：

```ts
const result = await enforcer.authorize({
  actorId: "worker-01",
  role: "worker",
  missionId: "mission-01",
  taskId: "task-01",
  decisionType: "execution.method.select",
  action: "select",
})

expect(result.result).toBe("allow")
```

この2つが成立すれば、

```text
Mission Command型の

Command Boundary
+
Bounded Autonomy
```

の最小骨格がRuntimeに存在する。

---

# 49. Second Milestone

Delegation invariantを通す。

```text
Parent Effective Authority
        ↓
Delegation Request
        ↓
Subset Check
        ↓
ALLOW / DENY
```

最低限：

```text
narrower authority
→ ALLOW

greater authority
→ DENY
```

を確認する。

---

# 50. Third Milestone

C2 LoopへDoctrine Enforcementを統合する。

```text
Human
  ↓
Commander
  ↓
Runtime Enforcement
  ↓
Lead
  ↓
Runtime Enforcement
  ↓
Worker
  ↓
Runtime Enforcement
  ↓
Evaluator
  ↓
Runtime Enforcement
  ↓
State
```

通常Missionを最後まで完了できること。

同時に、意図的なBoundary Violationが正しく阻止されること。

---

# 51. Definition of Success

v0.2が成功した状態：

```text
Normal case:
下位Agentが自律的に動く

Boundary case:
正しい上位へEscalateする

Invalid case:
Runtimeが拒否する

Completion:
Evidence + Evaluation + Runtimeで確定する
```

つまり、

> **自律性と統制が同時に成立していること**

をv0.2の成功とする。

---

# 52. Prototype後の拡張

v0.2完成までは以下へ進まない。

```text
Multiple Workers
Parallel Execution
Multiple Leads
Staff System
Dynamic Organization
Message Bus
Distributed C2
Long-term Organizational Memory
```

Doctrine Enforcementが成立した後に、

```text
v0.3
Multiple Workers

v0.4
Parallel Execution

v0.5
Multiple Leads

v0.6
Staff Agents

v0.7+
Distributed / Dynamic C2
```

を検討する。

---

# 53. 実装依頼

既存の **Command & Control Runtime Prototype v0.1** を基盤として、本仕様に従い **Command & Control Runtime v0.2 — Doctrine Enforcement** を実装する。

最重要要件は以下である。

1. DoctrineのCommand BoundaryをRuntimeが強制する
2. Effective Authorityを決定論的に計算する
3. DelegationによるAuthority拡大を禁止する
4. 上位Constraintを下位が解除できない
5. Authority内では下位Agentの自律判断を妨げない
6. Boundary超過は適切なDecision OwnerへEscalateする
7. EvaluatorをCommand Chainから独立させる
8. State TransitionはRuntimeのみが実行する
9. Doctrine Enforcement結果を監査可能にする
10. Doctrine Compliance Testsで上記Invariantを保証する

設計判断に迷った場合は、

> **この実装はMission Command型の「Bounded Autonomy」を強めるか、それとも単なる中央集権化を生むか？**

を判断基準とする。

重要なDoctrineはPrompt上のお願いとして処理せず、可能な限りRuntime Invariantとして実装する。

同時に、すべてをRuntime承認制にして下位Agentの自律性を失わせないこと。

最終的に目指す状態は、

```text
Within Boundary
→ Decide locally

Across Boundary
→ Escalate

Doctrine Violation
→ Deny

Verified Success
→ Runtime transitions state
```

である。
