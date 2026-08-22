# Controlled Repository Execution v0.3 acceptance specification

本書は`Command & Control Runtime v0.3 — Controlled Repository Execution Implementation Brief.md`のAcceptance Criteriaを、後続Issueが自動テストへ直接対応付けるための規範的な検証表である。現時点の実装済み証拠を表す文書ではない。

## 1. 判定規則

- schemaやclassの存在だけでは、Runtime enforcementの証拠にしない。
- mockしたfilesystem/processだけではroot boundary、side effect、exit/timeoutのintegration証拠にしない。
- Scenario A–Jはtemporary Workspace、実SQLite、実ToolBroker、Runtime-managed Worker loopを通す。
- `DENY / ESCALATE`は戻り値だけでなく、操作前後のfilesystem snapshot/process spy、Authorization、Event、Stateを確認する。
- ToolEvidenceはDB recordを正本とし、Worker/Evaluatorの自己申告と照合する。
- completionはReport、Evidence Requirement、Evaluator PASS、Runtime permit、State/Eventの全てを確認する。
- 永続性要件はStoreをclose/reopenして確認する。
- 各testは`finally`でStoreをcloseし、temporary Workspaceを後始末する。

## 2. 予定する自動テスト配置

| Test ID | 予定ファイル | 主対象 |
| --- | --- | --- |
| UT-WS | `tests/tools/workspace-path-resolver.test.ts` | AC-03, AC-06 |
| UT-TR | `tests/unit/tool-contracts.test.ts` | AC-04, AC-05 |
| UT-TB | `tests/tools/tool-broker.test.ts` | AC-08, AC-10, AC-12 |
| UT-WL | `tests/unit/worker-tool-loop.test.ts` | AC-15, AC-19 |
| IT-AUDIT | `tests/integration/tool-evidence-persistence.test.ts` | AC-07, AC-13, AC-14 |
| IT-CRE | `tests/integration/controlled-repository-execution.test.ts` | AC-09, AC-16〜AC-20 |
| IT-EXPORT | `tests/integration/public-exports.test.ts` | AC-23 |
| REG-V02 | 既存`tests/unit/`, `tests/integration/`, `tests/doctrine/` | AC-21, AC-24 |

ファイル名は実装時に統合してよいが、Test IDと検証範囲を失ってはならない。

## 3. Required Integration Scenarios

各ScenarioのStateは、記載した観測時点の期待値である。全Scenarioで、ToolRequest identityはRuntimeが付与し、Workspace rootはAgent inputに含めない。

### Scenario A — Read-only repository inspection

| 項目 | 規範値 |
| --- | --- |
| 入力 | Workspaceに`src/a.ts`を作成。Workerが`repo.list { path: "src", maxDepth: 2 }`、`repo.search { query: "answer", paths: ["src"], maxResults: 10 }`、`repo.read { path: "src/a.ts", offset: 0, limit: 4096 }`を順に提案し、Evidenceを引用したsuccess Reportを返す。Task requirementsは3 toolと`src/a.ts`を要求する。 |
| Authorization | 3 Request全て、selection Authorization（`execution.tool.select` + `tool.select` + tool scope）と全resolved pathのoperation Authorization（`code.read` + path scope）を`ALLOW`し、Evidence/permitは両者のbundleへbindする。 |
| Side effect | Workspaceの全file hash、mtime、entry集合が実行前後で不変。process起動なし。 |
| State | tool loop中Task=`running`。Evaluator PASSとcompletion gate後にTask=`completed`、Mission=`completed`。 |
| Event | 各Requestのproposed、authorized、succeeded event。最後にReport、EvaluationPassed、TaskCompleted、MissionCompleted。 |
| Evidence | sequence 1〜3のsuccessful Evidence。list entries、search match、read content/hashがDB recordと一致。 |
| 自動証拠 | IT-CRE Scenario A、IT-AUDIT reopen assertion |

### Scenario B — Allowed in-scope patch

| 項目 | 規範値 |
| --- | --- |
| 入力 | `src/a.ts`のread EvidenceでSHA-256を取得後、同じpathへ`repo.patch { operation: "update", content: "...", expectedSha256 }`。Authorityは`src/**`の`code.edit`。requireMutation=true。 |
| Authorization | readとpatchはそれぞれselectionとoperation Authorizationを`ALLOW`。patch Evidence/permitはselectionとresolved `src/a.ts`の`code.edit` operation Authorization bundleへbind。 |
| Side effect | `src/a.ts`だけが完全置換され、他fileは不変。before/after hashが実fileと一致。 |
| State | patch後もTask=`running`。必要EvidenceとEvaluator PASS後だけcompleted。 |
| Event | `ToolRequestProposed`、`AuthorizationAllowed`、`ToolExecutionSucceeded`。最終completion events。 |
| Evidence | patch Evidenceにoperation=update、applied=true、before/after SHA-256、bytes。 |
| 自動証拠 | IT-CRE Scenario B、UT-TB stale SHA negative test |

### Scenario C — Out-of-scope path access

| 項目 | 規範値 |
| --- | --- |
| 入力 | Authority=`src/**`のWorkerが`repo.read { path: "README.md" }`または`repo.patch`を提案。 |
| Authorization | `DENY`。reasonはresource scope mismatchとして機械可読。 |
| Side effect | read contentをWorkerへ返さず、filesystem変更なし、ToolBroker実行回数0。 |
| State | DENY直後はTask=`running`、Mission=`executing`。残budget内で代替Request可。 |
| Event | proposed、AuthorizationDenied。ToolExecution eventなし。 |
| Evidence | ToolEvidenceなし。Authorization recordが非実行の正本。 |
| 自動証拠 | IT-CRE Scenario C |

### Scenario D — Symlink boundary escape

| 項目 | 規範値 |
| --- | --- |
| 入力 | Workspace内`escape`をWorkspace外temporary directoryへのsymlinkにし、`repo.read escape/secret.txt`と`repo.patch escape/new.txt`を試す。 |
| Authorization | path resolution boundaryで`DENY`。Doctrineへ渡す場合も外部canonical pathをALLOWしてはならない。 |
| Side effect | 外部secretを返さず、外部/内部とも変更なし、ToolBroker operation 0。 |
| State | Task=`running`、Mission=`executing`のまま。 |
| Event | proposed、boundary denial/AuthorizationDenied。ToolExecution eventなし。 |
| Evidence | なし。error/control resultにstable code `WORKSPACE_ESCAPE`。 |
| 自動証拠 | IT-CRE Scenario D、UT-WS symlink/read/create-parent cases |

### Scenario E — Allowed test execution

| 項目 | 規範値 |
| --- | --- |
| 入力 | Policyに`unit`=`node --test ...`相当のfixed argvを登録。Workerは`test.run { commandId: "unit" }`だけを提案。 |
| Authorization | selection Authorization（`execution.tool.select` + `tool.select` + `{type:"tool",tool:"test.run"}`）とoperation Authorization（`test.run` + `{type:"tool",tool:"unit"}`）を`ALLOW`。Evidence/permitは両者のbundleへbindする。 |
| Side effect | 設定済みprocessを一回、shell=false、fixed cwd/envで実行。Repository file変更なし。 |
| State | test中/後Task=`running`。requireSuccessfulTestとEvaluator PASS後completed可能。 |
| Event | proposed、allowed、ToolExecutionSucceeded。 |
| Evidence | status=succeeded、exitCode=0、stdout/stderr/hash、duration、commandId。secret envは含まない。 |
| 自動証拠 | IT-CRE Scenario E、UT-TB argv/env/shell assertions |

### Scenario F — Failing test prevents completion

| 項目 | 規範値 |
| --- | --- |
| 入力 | fixed test commandがexit 1。Workerはその後success Report、Evaluator doubleはPASSを提案する。TaskはrequireSuccessfulTest=true。 |
| Authorization | test Requestは`ALLOW`。completion transitionの前提は満たさない。 |
| Side effect | test process以外のTool副作用なし。 |
| State | Task/Missionを`completed`にしない。final後はTask=`failed`、Mission=`failed`（または既存Evaluator FAIL recommendationに従う非completed terminal/loop state）。最低保証はcompleted不可。規範scenarioではPASS偽装を使うため`failed`とする。 |
| Event | ToolExecutionFailed、ReportSubmitted、EvaluationPassed、TaskCompletionRejected、TaskFailed、MissionFailed。TaskCompletedなし。 |
| Evidence | status=failed、exitCode=1のEvidenceが保存され、削除・successへ上書き不可。 |
| 自動証拠 | IT-CRE Scenario F |

### Scenario G — Approval-required operation escalates before execution

| 項目 | 規範値 |
| --- | --- |
| 入力 | `test.run deploy`またはcredential/network相当のoperationがTask authorityのrequiresApprovalにある。Workerが提案。 |
| Authorization | `ESCALATE`。targetは既存Doctrine/Decision ownerから決める。 |
| Side effect | process起動0、filesystem変更0、network adapter呼出し0。 |
| State | Task=`blocked`、Mission=`escalated`。 |
| Event | proposed、AuthorizationEscalated、EscalationCreated、TaskBlocked、EscalationRequested。ToolExecution eventなし。 |
| Evidence | ToolEvidenceなし。AuthorizationとEscalation recordが保存される。 |
| 自動証拠 | IT-CRE Scenario G |

### Scenario H — Worker claims success without sufficient Evidence

| 項目 | 規範値 |
| --- | --- |
| 入力 | requiredTools=`["repo.patch","test.run"]`だが、WorkerがToolRequestを出さずsuccess Reportを返し、Evaluator doubleもPASSを返す。 |
| Authorization | Report/Evaluationの既存認可がALLOWでも、completion gateは別に失敗する。 |
| Side effect | なし。 |
| State | Task=`failed`、Mission=`failed`。completedにならない。 |
| Event | ReportSubmitted、EvaluationPassed、TaskCompletionRejected、TaskFailed、MissionFailed。ToolExecution/TaskCompletedなし。 |
| Evidence | ToolEvidence 0件。Workerがoutputに埋めたfake Evidence IDは無視される。 |
| 自動証拠 | IT-CRE Scenario H |

### Scenario I — Tool limit exhaustion

| 項目 | 規範値 |
| --- | --- |
| 入力 | maxToolRequests=3。Workerが3回のDENYまたはfailed Request後に4つ目を提案する。 |
| Authorization | 最初の3件は各条件どおり。4件目はDoctrine/ToolBrokerへ渡さずlimitで拒否。 |
| Side effect | 4件目の副作用なし。先行Evidenceの実際のside effectだけを保持。 |
| State | Task=`failed`、Mission=`failed`。 |
| Event | 先行recordに続き`ToolLimitExhausted`、TaskFailed、MissionFailed。4件目のToolExecutedなし。 |
| Evidence | 実行された先行Request分だけ。sequenceの重複や4件目のfake Evidenceなし。 |
| 自動証拠 | IT-CRE Scenario I、UT-WL off-by-one test |

### Scenario J — Full repository change completes with durable audit

| 項目 | 規範値 |
| --- | --- |
| 入力 | Workerがlist/search/readで対象特定、SHA付きpatch、test.runを行い、全Evidenceを根拠にsuccess Report。requirementsはread、patch、fresh successful test、対象path、mutationを要求。 |
| Authorization | 全Requestでselectionと全concrete operation Authorizationが順に`ALLOW`。Requestごとに一意の事前Authorization bundleがある。 |
| Side effect | scope内の指定fileだけが期待内容へ変更され、testは変更後に一回成功。 |
| State | 実行中はTask=`running`。Report保存→Evaluator PASS→completion gate→Task completed→Mission completed。 |
| Event | request/authorization/executionがsequence順。ReportSubmitted、EvaluationPassed、TaskCompleted、MissionCompletedが後続。 |
| Evidence | 全RequestのEvidence、patch hash/side effect、変更後test exit 0が存在。Store reopen後も同一でappend-only mutationが拒否される。 |
| 自動証拠 | IT-CRE Scenario J、IT-AUDIT reopen/append-only assertions、built CLI smoke |

## 4. Acceptance Criteria traceability

| AC | 必須証拠 | 主Test ID |
| --- | --- | --- |
| AC-01 | Brief §2–3とREADME roadmap | 文書監査 |
| AC-02 | Brief §4、実装docs、threat boundary negative tests | UT-WS, UT-TB |
| AC-03 | absolute/traversal/separator/symlink/create-parent cases | UT-WS, Scenario D |
| AC-04 | strict union、unknown field、Runtime identity overwrite | UT-TR |
| AC-05 | wrong request/selection-or-operation auth/task/attempt、bundle digest、duplicate rejection | UT-TR, IT-AUDIT |
| AC-06 | exact、descendant、sibling-prefix、multi-root fail-closed | UT-WS |
| AC-07 | selectionと全operation Authorizationのcommitがbroker invocationより先。multi-rootの一件DENY/ESCALATEは全体を止める | IT-AUDIT, Scenario A, J |
| AC-08 | missing/wrong/reused authorization bundle permit rejection | UT-TB, IT-EXPORT |
| AC-09 | filesystem snapshot/process spy | Scenarios C, D, G |
| AC-10 | 各toolのhappy/invalid/bound tests | UT-TB, Scenarios A, B, E |
| AC-11 | unknown shell/network tool schema拒否、public export scan | UT-TR, IT-EXPORT |
| AC-12 | commandId only、argv injection拒否、env、cwd、timeout | UT-TB, Scenario E |
| AC-13 | success/failure/timeout Evidence+Event transaction、observation不能なfailure/timeoutではerrorだけを保存し架空のexit code/hash/outputを拒否 | IT-AUDIT, UT-TE |
| AC-14 | UPDATE/DELETE trigger、close/reopen、order | IT-AUDIT, Scenario J |
| AC-15 | Worker input clone、direct broker/store非公開 | UT-WL, IT-EXPORT |
| AC-16 | Evidence-backed evaluation input、direct state mutation拒否 | IT-CRE, 既存Evaluator isolation tests |
| AC-17 | fake success/PASS negative cases | Scenarios F, H |
| AC-18 | required tool/path/mutation、test freshness | Scenarios B, F, J |
| AC-19 | §17 outcome matrix全branch | UT-WL, IT-CRE |
| AC-20 | Scenario A–J各subtest | IT-CRE |
| AC-21 | `corepack pnpm run check` | REG-V02 |
| AC-22 | check、`corepack pnpm run ci:smoke`、`git diff --check` | CI gate |
| AC-23 | package self-reference negative imports | IT-EXPORT |
| AC-24 | Doctrine fileがbaseと同一 | git diff assertion |
| AC-25 | dependency/config/public API audit | completion audit |

## 5. Completion gate commands

後続実装の最終acceptanceでは最低限次を実行し、結果を本書のCompletion snapshotへ追記する。

```bash
corepack pnpm run check
corepack pnpm run ci:smoke
git diff --check
```

加えて、Scenario Jのtemporary Workspace実行結果について次を保存する。

- Mission/Task final state
- AuthorizationのALLOW/DENY/ESCALATE件数
- ToolRequest/Evidence件数とsequence
- patch前後SHA-256
- test commandId/exit code
- reopen後のEvent/Evidence件数
- append-only更新拒否結果

## 6. 現在の証拠境界

この文書作成時点ではv0.3 product codeとScenario A–Jは未実装である。本書のcheckboxや予定test pathは将来のacceptance contractであり、現在のPASSを主張しない。v0.2の既存check結果はv0.3 completionの代用にならない。
