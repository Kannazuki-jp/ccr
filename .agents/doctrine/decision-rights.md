---
title: Decision Rights Doctrine
version: 0.1
status: draft
scope: Command & Control Runtime Prototype v0.1
---

# Decision Rights Doctrine v0.1

## 1. Purpose

本ドキュメントは、Command & Control Runtime における意思決定権限の境界を定義する。

本Runtimeは **Mission Command型** を採用する。

上位層は目的・優先順位・制約・権限境界を定義し、下位層はその境界内で実行方法と局所的判断を自律的に決定する。

基本原則：

> 意思決定は、上位のIntentおよびConstraintsを侵害せず、その判断に必要な権限・コンテキスト・能力を持つ最も低い階層で行う。

---

## 2. Roles

Prototype v0.1では以下の役割を定義する。

| Role | Primary Responsibility |
|---|---|
| Human | GoalおよびStrategic Boundaryの所有 |
| Commander | Mission、Intent、Mission Boundaryの所有 |
| Lead | Plan、Task、Delegationの所有 |
| Worker | Execution / HOWの所有 |
| Evaluator | 成果の独立評価 |
| Runtime | Authority / State / State Transitionの強制 |

EvaluatorはCommand Chain上の上官ではない。

Runtimeは意思決定主体ではなく、AgentやHumanによる判断を検証・強制するControl機構である。

---

## 3. Decision Right Types

| Symbol | Meaning |
|---|---|
| **O** | Owner — 正式な意思決定権限を持つ |
| **D** | Delegated — 委譲された範囲内で判断可能 |
| **P** | Propose — 変更提案は可能だが決定権はない |
| **V** | Verify — 判断・成果を独立評価する |
| **E** | Enforce — Runtimeが機械的に制約・状態遷移を強制する |
| — | 当該判断権限を持たない |

上位Agentであること自体は、下位Agentが所有する判断への常時介入権を意味しない。

---

## 4. Command Boundaries

### 4.1 Human Boundary

HumanはStrategic Levelを所有する。

Humanが所有する主な判断：

- Goalの設定
- Goalの変更
- Strategic Constraintの設定・変更
- Commanderの権限を越える不可逆・重大判断
- 必要に応じたMission中止の最終判断

Commander以下はGoalを独自に変更してはならない。

Goal変更が必要な場合はHumanへEscalateする。

---

### 4.2 Commander Boundary

CommanderはMission Levelを所有する。

Commanderが所有する主な判断：

- Missionの作成
- Mission Purpose
- Commander’s Intent
- Desired End State
- Mission Priority
- Mission Constraints
- Mission Success Criteria
- Mission Scope
- Mission LevelのAuthority Boundary

Commanderは原則としてTaskの具体的実行方法を規定しない。

Commanderは主として以下を定義する。

```text
WHY
WHAT
BOUNDARIES
```

---

### 4.3 Lead Boundary

LeadはPlanning / Coordination Levelを所有する。

Leadが所有する主な判断：

- MissionからTaskへの分解
- Taskの作成・削除・置換
- Task Objective
- Task Success Criteria
- Task Constraints
- Task Dependencies
- Task Assignment
- Task実行順序
- Workerへ渡すContext
- WorkerへのAuthority Delegation
- Task Plan / Mission PlanのReplanning

LeadはMission PurposeやGoalを独自に変更してはならない。

---

### 4.4 Worker Boundary

WorkerはExecution Levelを所有する。

Workerが所有する主な判断：

- 実装方法
- アルゴリズム
- Tool選択
- Task内部の処理手順
- 権限内の局所変更
- Local Retry
- 未知の問題への局所対応
- Task Resultの生成
- Structured Reportの生成

Workerは与えられたTask、Intent、Authority、Constraintsの範囲内では追加承認を待たずに判断・実行する。

---

### 4.5 Evaluator Boundary

Evaluatorは独立したAssessment機能を持つ。

Evaluatorが所有する主な判断：

- Evidenceの検査
- Success Criteria充足判定
- PASS / FAIL判定
- retry / replan / escalate / fail の推奨

EvaluatorはMissionやTaskの状態を直接変更しない。

---

### 4.6 Runtime Boundary

RuntimeはEnforcement Authorityを持つ。

Runtimeの責務：

- Structured Output Validation
- Authority Check
- Constraint Check
- State Machine Enforcement
- State Transition
- Event Recording
- Decision Recording
- Invalid Transitionの拒否

Runtimeは以下を独自に決定しない。

- Goal
- Mission Purpose
- Plan
- Task
- HOW

原則：

> Agent decides. Runtime controls.

---

## 5. Strategic / Command Decision Matrix

| Decision | Human | Commander | Lead | Worker | Evaluator | Runtime |
|---|---:|---:|---:|---:|---:|---:|
| Goal設定 | **O** | P | — | — | — | E |
| Goal変更 | **O** | P | — | — | — | E |
| Strategic Constraint設定 | **O** | P | — | — | — | E |
| Mission作成 | D | **O** | — | — | — | E |
| Mission Purpose | P | **O** | P | — | — | E |
| Desired End State | P | **O** | P | — | — | E |
| Mission Priority | P | **O** | P | — | — | E |
| Mission Constraint | P | **O** | P | — | — | E |
| Mission Success Criteria | P | **O** | P | — | V | E |
| Mission Scope変更 | P | **O** | P | — | — | E |
| Mission中止 | **O** | D | P | — | — | E |

---

## 6. Planning / Delegation Decision Matrix

| Decision | Human | Commander | Lead | Worker | Evaluator | Runtime |
|---|---:|---:|---:|---:|---:|---:|
| Mission → Task分解 | — | P | **O** | P | — | E |
| Task作成 | — | D | **O** | P | — | E |
| Task削除 | — | D | **O** | P | — | E |
| Task Objective | — | D | **O** | P | — | E |
| Task Success Criteria | — | D | **O** | P | V | E |
| Task Constraint | — | D | **O** | P | — | E |
| Task Dependencies | — | D | **O** | P | — | E |
| WorkerへのTask割当 | — | D | **O** | — | — | E |
| Task実行順序 | — | P | **O** | D | — | E |
| Context配布 | — | P | **O** | — | — | E |
| WorkerへのAuthority委譲 | — | D | **O** | — | — | E |

---

## 7. Execution Decision Matrix

| Decision | Human | Commander | Lead | Worker | Evaluator | Runtime |
|---|---:|---:|---:|---:|---:|---:|
| 実装方法 | — | — | P | **O** | — | E |
| アルゴリズム | — | — | P | **O** | — | E |
| Tool選択 | — | — | D | **O** | — | E |
| 局所的な構造変更 | — | — | D | **O** | — | E |
| 権限内の変更操作 | — | — | D | **O** | — | E |
| Local Retry | — | — | D | **O** | P | E |
| Task内部の手順変更 | — | — | D | **O** | P | E |
| Task Result作成 | — | — | — | **O** | — | — |
| Structured Report作成 | — | — | — | **O** | — | E |
| 未知の問題への局所対応 | — | — | D | **O** | — | E |

---

## 8. Replanning Decision Matrix

| Decision | Human | Commander | Lead | Worker | Evaluator | Runtime |
|---|---:|---:|---:|---:|---:|---:|
| Local Retry | — | — | D | **O** | P | E |
| Task内部Execution Plan変更 | — | — | D | **O** | P | E |
| Task Plan変更 | — | P | **O** | P | P | E |
| Task追加・置換 | — | P | **O** | P | P | E |
| Mission Plan再構成 | — | D | **O** | P | P | E |
| Mission Scope変更 | P | **O** | P | — | P | E |
| Mission Purpose変更 | P | **O** | P | — | — | E |
| Goal変更 | **O** | P | — | — | — | E |

Strategic ConstraintがHuman由来の場合、Commanderは変更できない。

Commander自身が設定したMission Constraintのみ、Commander Boundary内で変更可能とする。

---

## 9. Escalation Doctrine

Escalationは「判断に迷ったから上位へ聞く」ための一般相談機構ではない。

原則：

> 現在のDecision Ownerでは解決できず、より上位のCommand Boundaryを越える判断が必要になった場合にEscalationする。

### Escalation Levels

```text
Worker
  │
  │ HOWの変更で解決可能
  └─ Resolve Locally
  │
  │ Task Plan変更が必要
  ▼
Lead
  │
  │ Task / Plan変更で解決可能
  └─ Resolve
  │
  │ Mission変更が必要
  ▼
Commander
  │
  │ Mission Boundary内で解決可能
  └─ Resolve
  │
  │ Goal / Strategic Boundary変更が必要
  ▼
Human
```

### Escalation Table

| Situation | Worker | Lead | Commander | Human |
|---|---|---|---|---|
| HOW変更で解決 | Resolve | — | — | — |
| Task Plan変更が必要 | Escalate | Resolve | — | — |
| Mission Scope変更が必要 | Escalate | Escalate | Resolve | — |
| Intent変更が必要 | Escalate | Escalate | Resolve | — |
| Strategic Constraint変更 | Escalate | Escalate | Escalate | Resolve |
| Goal変更が必要 | Escalate | Escalate | Escalate | Resolve |
| Authority超過 | Escalate | Resolve / Escalate | Resolve / Escalate | Final |

---

## 10. Bounded Autonomy

Agentの自律性は無制限ではない。

```text
Autonomy
=
Intent
+ Authority
+ Constraints
```

Agentはこの境界内では自律的に判断する。

境界外の行動を必要とする場合はEscalationする。

上位Agentは、下位Agentが自身のAuthority Boundary内で行う判断へ必要以上に介入しない。

---

## 11. Effective Authority

実際にAgentが行使可能な権限はRoleだけでは決定しない。

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

例：

```yaml
role_authority:
  code_edit: allowed
  tool_selection: allowed
  production_deploy: prohibited

mission_delegation:
  code_edit:
    paths:
      - src/auth/**
  dependency_addition: requires_approval

constraints:
  - public_api_must_not_change
```

この場合、WorkerはRole Authorityでコード編集権限を持っていても、Mission上は`src/auth/**`と上位Constraintの範囲内でのみ行使できる。

---

## 12. Delegation Rules

### Rule 1 — No Authority Creation

Agentは、自身が持っていない権限を下位Agentへ新たに作り出してはならない。

```text
DelegatedAuthority(child)
⊆
EffectiveAuthority(parent)
```

### Rule 2 — Delegation May Narrow Authority

上位Agentは下位Agentへ権限を委譲する際、対象・範囲・期間・Risk Limit等によって権限を狭めることができる。

### Rule 3 — Higher Constraints Survive Delegation

上位層から継承したConstraintは、下位層へのDelegationによって解除されない。

### Rule 4 — Delegation Does Not Transfer Goal Ownership

Authorityを委譲しても、上位層が所有するGoal / Mission Purpose / Intent等のCommand Ownershipは移転しない。

### Rule 5 — Delegated Authority Is Revocable

状況変化、Risk増大、Constraint違反、Mission変更等が発生した場合、上位Agentは委譲した権限を縮小または取り消すことができる。

Runtimeは権限変更をEventとして記録する。

---

## 13. Evaluation and Completion

Agent自身による完了宣言は、TaskまたはMissionの完了を意味しない。

```text
Execution
   ↓
Evidence
   ↓
Evaluation
   ↓
Runtime Validation
   ↓
State Transition
```

Evaluatorは独立して成果を評価する。

RuntimeのみがState Machineに従って状態を遷移させる。

---

## 14. Replanning Hierarchy

Replanningは変更対象となるBoundaryに応じて担当を変える。

```text
Level 1 — Worker Replan
HOWのみ変更

        ↓ 不十分

Level 2 — Lead Replan
Task / Planを変更

        ↓ 不十分

Level 3 — Commander Replan
Mission Scope / Intent等を変更

        ↓ 不十分

Level 4 — Human Decision
Goal / Strategic Boundaryを変更
```

下位層は上位Boundaryを直接変更しない。

変更が必要な場合はPropose + Escalateする。

---

## 15. Core Doctrine

本Decision Rights Doctrineは以下の原則を採用する。

### Principle 1 — Mission Command

上位層は目的・優先順位・制約・権限境界を定義し、実行方法は可能な限り下位層へ委譲する。

### Principle 2 — Preserve Command Boundaries

下位Agentは、上位Agentから与えられたGoal、Intent、Mission Purpose、Constraintsを独自に変更しない。

### Principle 3 — Lowest Competent Authority

意思決定は、その判断に必要な権限・コンテキスト・能力を持つ最も低い階層で行う。

### Principle 4 — Bounded Autonomy

AgentはIntent・Authority・Constraintsの範囲内では追加承認なしに自律的に判断・実行する。

### Principle 5 — Exception-based Control

正常系は下位Agentの自律判断を優先し、Command Boundaryを越える例外のみEscalateする。

### Principle 6 — Evidence-based Completion

Agentの自己申告ではなくEvidenceと独立Evaluationによって完了を判定する。

### Principle 7 — Runtime Enforcement

Agentは判断する。RuntimeはAuthority、Constraints、State Transitionを強制する。

---

## 16. Prototype v0.1 Scope

本Doctrine v0.1は以下の最小組織を対象とする。

```text
Human
  ↓
Commander
  ↓
Lead
  ↓
Worker

Evaluator
  ↓
Independent Assessment

Runtime
  ↓
Authority / State Enforcement
```

複数Lead、複数Worker、Staff Agents、動的なCommand Chain等はPrototype v0.1の対象外とする。

それらを追加する場合も、本DoctrineのCommand BoundaryおよびDecision Rights原則を維持する。
