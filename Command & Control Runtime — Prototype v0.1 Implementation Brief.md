# Command & Control Runtime — Prototype v0.1 Implementation Brief

## 1. この文書の目的

軍事組織の **Command & Control（C2 / 指揮統制）** の考え方を参考にした、AIエージェント組織の実行基盤 **Command & Control Runtime** のプロトタイプを実装する。

このプロトタイプの目的は、多数のAIエージェントを動かすことではない。

最初に、

> **Goal → Mission → Task → Execute → Evaluate → Replan / Complete**

という最小の指揮統制ループを、再現可能なソフトウェアシステムとして成立させる。

---

# 2. 基本思想

このシステムでは、AIエージェントとRuntimeの責務を明確に分離する。

```text
Agent
=
Intelligence / Judgment
判断・計画・実行

Runtime
=
Authority / State / Control
権限・状態・統制
```

重要な原則：

> **LLMにシステム状態を所有させない。**

LLMは判断結果をStructured Outputとして返す。

その結果を検証し、状態遷移を実行する責任はRuntime側が持つ。

例えばWorker Agentが、

```text
「Taskは完了しました」
```

と回答しただけではTaskを`completed`にしない。

```text
Worker Result
      ↓
Evaluator
      ↓
Runtime validation
      ↓
State transition
      ↓
Task = completed
```

とする。

---

# 3. Prototype v0.1 の完成定義

以下の一連の処理が成立すればPrototype v0.1を完成とする。

```text
Human
  │
  │ Goal
  ▼
Commander
  │
  │ Mission / Intent
  ▼
Lead
  │
  │ Tasks
  ▼
Worker
  │
  │ Result / Report
  ▼
Evaluator
  │
  ├── PASS
  │     │
  │     ▼
  │ Mission Completed
  │
  └── FAIL
        │
        ├── 修正可能
        │      ↓
        │    Replan
        │      ↓
        │    Lead
        │
        └── 権限外
               ↓
            Escalate
               ↓
        Commander / Human
```

Prototypeの本質は、

> **指揮 → 実行 → 報告 → 評価 → 再指揮**

のループが成立すること。

---

# 4. Prototype v0.1 のスコープ

## 含める

- Commander Agent
- Lead / Planner Agent
- Worker Agent
- Evaluator Agent
- Goal
- Mission
- Commander’s Intent
- Mission Order
- Task decomposition
- Task execution
- Structured Report
- Evaluation
- Replanning
- Escalation
- Mission / Task状態管理
- 状態永続化
- Decision Log
- Event Log
- Mock Agent
- LLM Agentへ差し替え可能なinterface
- CLIまたは最低限の実行インターフェース
- Integration Test

## Prototypeでは含めない

以下はPrototype v0.1では実装しない。

- 複数Workerの並列実行
- 複数Lead
- Staff Agent群
- 動的Agent生成
- Agent間P2P通信
- Message Bus
- Kafka
- Google Pub/Sub
- Redis
- Temporal等のWorkflow Engine
- Vector DB
- Graph DB
- 長期Memory
- 本格的Event Sourcing
- マルチユーザー
- 高度なWeb UI
- 分散Runtime

これらはv0.1完成後の拡張対象とする。

---

# 5. 最小Agent組織

Prototypeでは以下の4種類だけを使用する。

```text
                    Human
                      │
                     Goal
                      │
                      ▼
                 Commander
                      │
              Mission / Intent
                      │
                      ▼
                    Lead
                      │
                    Tasks
                      │
                      ▼
                   Worker
                      │
             Result / Report
                      │
                      ▼
                 Evaluator
                   /     \
                PASS     FAIL
                 │         │
                 ▼         ▼
             Complete    Replan
```

---

# 6. 各Agentの責務

## Commander

入力：

```text
Goal
```

出力：

```text
Mission
Commander’s Intent
Constraints
Success Criteria
Priorities
```

Commanderは実装方法を細かく指示しない。

Commanderが主に決めるもの：

```text
WHY
WHAT
BOUNDARIES
```

具体的な`HOW`は下位Agentへ委譲する。

---

## Lead

入力：

```text
Mission
Commander’s Intent
Current Mission State
```

責務：

- Missionを実行可能なTaskへ分解する
- Task間依存関係を決める
- Workerへ渡すTask Contextを作る
- WorkerからのReportを集約する
- 必要に応じてReplanする

---

## Worker

入力：

```text
Task
Relevant Context
Authority
Constraints
```

責務：

- Taskを実行する
- 実行方法を自身の権限内で判断する
- Resultを生成する
- Structured Reportを返す
- 権限外の判断が必要ならEscalationを要求する

Worker自身はMission全体の状態を変更しない。

---

## Evaluator

入力：

```text
Task
Task Result
Success Criteria
```

責務：

- Task ResultがSuccess Criteriaを満たしているか評価する
- PASS / FAILを返す
- FAILの場合は理由を返す
- 再実行可能か、Replanが必要かを示す

Evaluatorの結果を基にRuntimeが状態遷移を行う。

---

# 7. Command & Control の基本構造

## Command Flow

```text
Human
  ↓
Commander
  ↓
Lead
  ↓
Worker
```

上位から下位には以下を伝える。

```text
Goal
Intent
Mission
Priority
Constraints
Authority
Success Criteria
```

---

## Control / Feedback Flow

```text
Human
  ↑
Commander
  ↑
Lead
  ↑
Worker
```

下位から上位には以下を返す。

```text
Status
Result
Progress
Problem
Risk
Decision Required
Escalation Request
```

生ログをそのまま上位へ渡すのではなく、必要な情報へ圧縮する。

---

# 8. Commander’s Intent

Commander’s Intentは最低限以下の構造を持つ。

```yaml
purpose:
  なぜこのMissionを行うのか

end_state:
  Mission完了時にどうなっているべきか

priorities:
  何を優先するか

constraints:
  絶対に守るべき制約
```

例：

```yaml
purpose:
  ユーザーがGoogleアカウントでログインできるようにする

end_state:
  - loginできる
  - logoutできる
  - sessionが復元される

priorities:
  - security
  - reliability
  - development_speed

constraints:
  - existing public API must not change
  - production DB schema must not change
```

---

# 9. Mission Order

下位Agentに渡すMission / Taskでは、実行方法を必要以上に指定しない。

```yaml
objective:
  達成すべきこと

purpose:
  なぜ必要なのか

success_criteria:
  - 条件1
  - 条件2

constraints:
  - 制約

authority:
  allowed:
    - 許可された操作

  prohibited:
    - 禁止された操作
```

基本原則：

```text
上位層
→ WHY / WHAT / BOUNDARIES

下位層
→ HOW
```

---

# 10. Domain Model

最低限以下をDomain Modelとして定義する。

```text
Goal
Mission
Task
Agent
Report
Evaluation
Decision
Event
```

---

## Mission

概念例：

```ts
type Mission = {
  id: string

  goal: string

  intent: {
    purpose: string
    endState: string[]
    priorities: string[]
    constraints: string[]
  }

  successCriteria: string[]

  status:
    | "created"
    | "planning"
    | "executing"
    | "evaluating"
    | "replanning"
    | "blocked"
    | "escalated"
    | "completed"
    | "failed"
    | "cancelled"

  createdAt: Date
  updatedAt: Date
}
```

---

## Task

```ts
type Task = {
  id: string
  missionId: string

  objective: string
  purpose?: string

  successCriteria: string[]
  constraints: string[]

  assignedAgentId?: string

  dependencies: string[]

  status:
    | "pending"
    | "running"
    | "evaluating"
    | "blocked"
    | "completed"
    | "failed"
    | "cancelled"

  createdAt: Date
  updatedAt: Date
}
```

---

## Report

```ts
type Report = {
  taskId: string
  agentId: string

  status:
    | "success"
    | "failure"
    | "blocked"

  summary: string

  problems: string[]
  risks: string[]

  decisionRequired: boolean

  escalation?: {
    required: boolean
    reason?: string
  }
}
```

---

## Evaluation

```ts
type Evaluation = {
  taskId: string

  result:
    | "pass"
    | "fail"

  reasons: string[]

  recommendation:
    | "complete"
    | "retry"
    | "replan"
    | "escalate"
    | "fail"
}
```

---

## Event

最低限以下を保存できること。

```ts
type Event = {
  id: string
  missionId: string

  type: string

  actor?: string

  payload: unknown

  createdAt: Date
}
```

Event例：

```text
MissionCreated
MissionPlanned
TaskCreated
TaskAssigned
TaskStarted
TaskBlocked
TaskCompleted
TaskFailed
EvaluationPassed
EvaluationFailed
DecisionMade
MissionReplanned
EscalationRequested
MissionCompleted
MissionFailed
```

---

# 11. Mission State Machine

Missionの状態遷移はRuntimeが管理する。

基本形：

```text
CREATED
   │
   ▼
PLANNING
   │
   ▼
EXECUTING
   │
   ▼
EVALUATING
  /       \
PASS      FAIL
 │          │
 ▼          ▼
COMPLETED  REPLANNING
              │
              ▼
          EXECUTING
```

例外状態：

```text
BLOCKED
ESCALATED
FAILED
CANCELLED
```

State MachineはLLMとは独立した通常のプログラムとして実装する。

---

# 12. Agent Interface

Runtimeが特定のLLM実装へ直接依存しないようにする。

概念例：

```ts
interface Agent<I, O> {
  execute(input: I): Promise<O>
}
```

役割別：

```ts
interface CommanderAgent {
  createMission(goal: Goal): Promise<MissionProposal>
}
```

```ts
interface LeadAgent {
  plan(mission: Mission): Promise<TaskProposal[]>

  replan(
    mission: Mission,
    context: ReplanContext
  ): Promise<TaskProposal[]>
}
```

```ts
interface WorkerAgent {
  execute(
    task: Task,
    context: WorkerContext
  ): Promise<TaskResult>
}
```

```ts
interface EvaluatorAgent {
  evaluate(
    task: Task,
    result: TaskResult
  ): Promise<Evaluation>
}
```

以下の交換を可能にすること。

```text
Runtime
   │
   ▼
Agent Interface
   │
   ├── Mock Agent
   │
   └── LLM Agent
```

---

# 13. Structured Output

LLMから返された自然文を直接Runtime状態へ反映しない。

必ず、

```text
LLM
 ↓
Structured Output
 ↓
Schema Validation
 ↓
Domain Object
 ↓
Runtime
```

とする。

Zod、JSON Schema等によるvalidationを行うこと。

例：

```json
{
  "tasks": [
    {
      "objective": "Implement authentication endpoint",
      "successCriteria": [
        "existing tests pass",
        "new authentication test passes"
      ],
      "dependencies": [],
      "constraints": []
    }
  ]
}
```

---

# 14. Escalation

Agentは自分の権限を超える操作を勝手に行わない。

```text
Worker
   │
   ├── 権限内
   │      ↓
   │   Worker判断
   │
   └── 権限外
          ↓
         Lead
          │
          ├── 権限内
          │      ↓
          │    Lead判断
          │
          └── 権限外
                 ↓
              Commander
                 │
                 └── 必要ならHuman
```

Prototypeでは複雑なRBACを作る必要はない。

最低限、

```text
allowed
prohibited
requiresApproval
```

を区別できればよい。

---

# 15. Replanning

EvaluatorがFAILを返した場合、必ず即座にMission失敗とはしない。

```text
Evaluation FAIL
       │
       ├── retry可能
       │      ↓
       │    retry
       │
       ├── 計画変更が必要
       │      ↓
       │    replan
       │
       ├── 権限外
       │      ↓
       │   escalate
       │
       └── 回復不能
              ↓
            failed
```

ReplanningはLeadの責務とする。

Commanderまで戻す必要があるのは、

- Missionの目的変更
- Commander’s Intentとの矛盾
- 制約変更
- 上位レベルの判断が必要

といった場合に限定する。

---

# 16. 永続化

Prototypeでは複雑なInfrastructureを使用しない。

推奨：

```text
Definition
→ Files

Runtime State
→ SQLite

History
→ SQLite events table
```

---

## Files

例：

```text
.agents/
├── doctrine/
├── roles/
└── skills/
```

ただし、**doctrineの具体的内容はPrototype実装時点では未定義**とする。

後から追加・変更可能な構造だけ用意する。

実装AIが独自判断でDoctrineを確定しないこと。

---

## SQLite

最低限：

```text
missions
tasks
agents
reports
decisions
events
```

を保持する。

Prototypeでは本格的Event Sourcingは不要。

`events`テーブルをappend-onlyの履歴として使用すればよい。

---

# 17. リポジトリ構成案

```text
agent-organization/
│
├── .agents/
│   ├── doctrine/
│   ├── roles/
│   └── skills/
│
├── src/
│   ├── domain/
│   │   ├── goal.*
│   │   ├── mission.*
│   │   ├── task.*
│   │   ├── report.*
│   │   ├── evaluation.*
│   │   └── event.*
│   │
│   ├── runtime/
│   │   ├── runtime.*
│   │   ├── state-machine.*
│   │   ├── escalation.*
│   │   └── replanning.*
│   │
│   ├── agents/
│   │   ├── commander/
│   │   ├── lead/
│   │   ├── worker/
│   │   └── evaluator/
│   │
│   ├── storage/
│   │   └── sqlite/
│   │
│   ├── llm/
│   │   └── provider.*
│   │
│   └── cli/
│
├── tests/
│   ├── unit/
│   └── integration/
│
└── evals/
```

具体的なプログラミング言語に合わせて拡張子等は変更してよい。

---

# 18. 実装順序

以下の順番を原則とする。

## Phase 0 — Skeleton

- プロジェクト作成
- ディレクトリ構成作成
- Test framework導入
- Schema validation導入
- SQLite準備

---

## Phase 1 — Domain Model

以下を実装する。

- Goal
- Mission
- Task
- Report
- Evaluation
- Decision
- Event

この時点ではLLMを使用しない。

---

## Phase 2 — State Machine

Mission / Taskの状態遷移を実装する。

不正な状態遷移を禁止する。

例：

```text
completed
→ running
```

のような遷移はRuntimeが拒否する。

---

## Phase 3 — Agent Interfaces

以下をinterfaceとして定義する。

- CommanderAgent
- LeadAgent
- WorkerAgent
- EvaluatorAgent

RuntimeとAgent実装を疎結合にする。

---

## Phase 4 — Mock Agents

固定値を返すMock Agentを実装する。

LLMを使用せず、

```text
Goal
→ Mission
→ Tasks
→ Execute
→ Evaluate
→ Completed
```

まで到達できるようにする。

---

## Phase 5 — Runtime

Command & Control Runtimeを実装する。

Runtimeの責務：

- State管理
- Agent呼び出し
- Structured Output validation
- State transition
- Event記録
- Report routing
- Replanning
- Escalation
- Mission completion判定

---

## Phase 6 — Persistence

SQLiteへ以下を保存する。

- Mission
- Task
- Report
- Decision
- Event

プロセスを再起動してもMission状態を読み出せるようにする。

---

## Phase 7 — Lead LLM

最初にLeadをMockからLLMへ置換する。

```text
Mission
↓
LLM Lead
↓
Task[]
```

を実現する。

---

## Phase 8 — Evaluator LLM

EvaluatorをLLM化する。

Task ResultとSuccess Criteriaから、

```text
PASS
FAIL
retry
replan
escalate
```

をStructured Outputで返せるようにする。

可能な判定は、LLMではなく決定論的コード・テストを優先すること。

---

## Phase 9 — Worker LLM / Tool Agent

Workerを実Agentへ置換する。

Prototypeでは1 Workerだけでよい。

---

## Phase 10 — Replan / Escalation

FAIL時に、

```text
Evaluator
↓
Lead.replan()
↓
new / modified Tasks
```

が動くことを確認する。

権限外操作ではHumanまたはCommanderへEscalateする。

---

## Phase 11 — Commander LLM

最後にCommanderをLLM化する。

```text
Goal
↓
Commander
↓
Mission
+ Intent
+ Success Criteria
+ Constraints
```

を生成する。

Commanderを最後にLLM化することで、Runtimeの問題とLLM判断の問題を切り分けやすくする。

---

## Phase 12 — Minimal Interface

CLI等から、

```text
run mission "<goal>"
```

のようにMissionを開始できる状態にする。

最低限表示する情報：

```text
Mission
Status
Current Task
Recent Event
Escalation
Final Result
```

高度なUIは作らない。

---

# 19. 最初のIntegration Test

最初に通すべきテスト：

```ts
const result = await runtime.run({
  goal: "Add completed todo endpoint"
})

expect(result.status).toBe("completed")
```

Mock Agentsを使用して、

```text
Goal
→ Commander
→ Lead
→ Worker
→ Evaluator
→ Completed
```

を通す。

これが最初のマイルストーン。

---

# 20. Prototype用ユースケース

最初の検証対象は1種類に限定する。

推奨：

> 既存ソフトウェアRepositoryへの小規模な機能追加

例：

```text
Goal:
TODO APIに「完了済みTodo一覧取得」を追加する
```

想定：

```text
Commander
↓
Mission / Intent

Lead
↓
Task 1: 既存API調査
Task 2: endpoint実装
Task 3: tests追加

Worker
↓
実行

Evaluator
↓
test / success criteria確認
```

汎用Agent化はPrototype完成後に行う。

---

# 21. Acceptance Criteria

以下をすべて満たした時点でPrototype v0.1を完成とする。

- [ ] Goalを入力できる
- [ ] GoalからMissionを生成できる
- [ ] Commander’s Intentを表現できる
- [ ] MissionにSuccess Criteriaを持たせられる
- [ ] MissionをTaskへ分解できる
- [ ] TaskをWorkerへ割り当てられる
- [ ] WorkerがTask Resultを返せる
- [ ] WorkerがStructured Reportを返せる
- [ ] EvaluatorがPASS / FAILを判定できる
- [ ] PASSしたTaskをcompletedへ遷移できる
- [ ] FAILからretry / replanできる
- [ ] 権限外の判断をEscalateできる
- [ ] Mission / Taskの状態をSQLiteへ保存できる
- [ ] Decisionを保存できる
- [ ] Event履歴を保存できる
- [ ] Runtime再起動後に状態を読み取れる
- [ ] Mock AgentとLLM Agentをinterface経由で交換できる
- [ ] Missionをcompletedまで到達させられる
- [ ] Integration TestでC2ループ全体を検証できる

---

# 22. Prototype完成後まで実施しないこと

PrototypeのAcceptance Criteriaを満たす前に、以下へ進まないこと。

```text
複数Worker
↓
並列実行
↓
複数Lead
↓
Staff Agents
↓
Message Bus
↓
Workflow Engine
↓
Long-term Memory
```

Prototypeの目的はスケーラビリティではなく、

> **C2モデルそのものがAgent Runtimeとして成立することを検証すること**

である。

---

# 23. 実装上の重要原則

## Principle 1

```text
Agent decides.
Runtime controls.
```

---

## Principle 2

LLMに状態遷移を直接行わせない。

---

## Principle 3

LLM出力は必ずSchema Validationを通す。

---

## Principle 4

上位Agentは実行方法を必要以上に規定しない。

```text
Commander
→ WHY / WHAT / BOUNDARIES

Worker
→ HOW
```

---

## Principle 5

Raw Contextを全Agentへ共有しない。

各Agentには、その役割とTaskに必要なContextだけを渡す。

---

## Principle 6

失敗を例外として隠さない。

```text
Failure
Blocked
Escalation
Replan
```

をDomain Modelとして明示的に扱う。

---

## Principle 7

複雑さは必要になるまで導入しない。

SQLiteで成立するものにKafka等を導入しない。

---

# 24. Doctrineについて

`doctrine`は、Agent Organizationが

- どのように判断するか
- どのように権限委譲するか
- いつEscalationするか
- 何を報告するか
- どのような自律性を許可するか
- 失敗時にどう行動するか

などを規定する、組織としての行動原則である。

ただし、**Doctrineの具体的内容はこのPrototype Implementation Briefのスコープ外とする。**

現時点では、

```text
.agents/doctrine/
```

という拡張ポイントを用意するだけに留める。

Doctrineの内容を実装AIが独自に決めたり、過剰に仮定したりしないこと。

DoctrineはPrototype設計とは別に、人間と対話しながら策定する。

---

# 25. 最終的に作りたいもの

Prototype v0.1は、将来的に以下へ発展できる構造を持つ。

```text
                         Human
                           │
                          Goal
                           │
                           ▼
                      Commander
                           │
                 ┌─────────┼─────────┐
                 ▼         ▼         ▼
              Planner   Intelligence Evaluator
                 │
            ┌────┴────┐
            ▼         ▼
         Lead A     Lead B
            │         │
         Workers   Workers
```

ただし現在実装するのは、

```text
Human
  ↓
Commander
  ↓
Lead
  ↓
Worker
  ↓
Evaluator
```

のみとする。

---

# 26. 実装依頼

上記仕様に基づいて **Command & Control Runtime Prototype v0.1** を実装する。

実装時は以下を優先する。

1. Domain Model
2. State Machine
3. Agent Interface
4. Mock Agent
5. Runtime
6. Persistence
7. Integration Test
8. LLM Agentへの段階的置換

設計判断に迷った場合は、

> **最小の実装でC2ループを成立させられるか**

を判断基準とする。

PrototypeのAcceptance Criteriaに必要のないInfrastructureや抽象化は追加しない。

また、Doctrineに関する未定義部分については勝手に仕様を確定せず、後から差し替えられる設計に留める。