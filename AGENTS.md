# リポジトリガイドライン

## プロジェクト構成とモジュール

本リポジトリは、Node.js 24とESM TypeScriptで実装された、Doctrine強制機能を持つCommand & Control Runtimeです。製品コードは`src/`に置きます。ドメインモデルとZod schemaは`src/domain/`、オーケストレーションと状態遷移は`src/runtime/`、Doctrine認可は`src/runtime/doctrine/`、SQLite永続化は`src/storage/sqlite/`、Agent契約は`src/agents/`、特定providerに依存しないLLM adapterは`src/llm/`、CLI entry pointは`src/cli/`です。テストは目的に応じて`tests/unit/`、`tests/integration/`、`tests/doctrine/`へ配置します。受け入れ証拠は`evals/`、規範となる仕様は`.agents/doctrine/decision-rights.md`と各Implementation Briefで管理します。

## ビルド・テスト・開発コマンド

- `corepack pnpm install --store-dir .pnpm-store`: 固定されたpnpmで依存関係をインストールします。
- `corepack pnpm start -- run mission "example"`: Mock Agentを使用してCLIを実行します。
- `corepack pnpm run typecheck`: ファイルを出力せず、strict TypeScript検査を行います。
- `corepack pnpm run test:plain`: すべての`node:test` suiteを素早く実行します。
- `corepack pnpm run test`: Node.jsの試験的coverage計測を付けてテストします。
- `corepack pnpm run build`: ESM、型宣言、source mapを`dist/`へ生成します。
- `corepack pnpm run check`: typecheck、coverage付きテスト、buildを順に実行します。レビュー前に必ず使用してください。

## コーディング規約と命名

既存コードに合わせ、インデントは2スペース、文字列はダブルクォート、文末はセミコロンとし、複数行では末尾カンマを付けます。関数と値には`camelCase`、class・schema・exportする型には`PascalCase`、ファイルには`authority-resolver.ts`のようなkebab-caseを使います。可能な限りtype-only importを使い、NodeNext互換性のため相対importには`.js`拡張子を付けます。strictな型付け、readonly契約、決定論的なRuntime境界を維持してください。formatterやlinterは設定されていないため、周辺コードの形式に合わせ、compilerで確認します。

## テスト方針

`node:test`と`node:assert/strict`を使用します。ファイル名は`*.test.ts`とし、`describe`と`it`で振る舞いごとに整理してください。正常系だけでなく、権限、scope、constraint、risk、delegation、直接的なlifecycle回避に対する否定テストを追加します。一時SQLite databaseを使用し、storeは`finally`内で閉じてください。Doctrineの保証を変更した場合は、対応するacceptance文書も更新します。

## コミットとPull Request

現在の履歴は`feat: ...`というConventional Commits形式の件名を使用しています。`feat:`、`fix:`、`test:`、`docs:`などの簡潔なprefixを使い、1コミットの責務を限定してください。Pull Requestには、振る舞いとDoctrineへの影響、変更した境界やschema、関連するissueまたはbrief、`corepack pnpm run check`の結果を記載します。CLIの表示を変更した場合は実行結果を添付してください。通常、スクリーンショットは不要です。
