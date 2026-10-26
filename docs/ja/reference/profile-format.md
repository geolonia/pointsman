---
title: プロファイルの形式
description: 判定プロファイルのすべてのフィールド(質問、ポリシー、ファクト、テストケース、判定のチェーン)を、例を添えて説明します。
sidebar: { order: 10 }
translatedFrom: f97b3b6
---

判定プロファイルは、型の決まった質問とポリシーをひとまとめにしたもので、名前とバージョンを持ちます。エンジンは質問と状態(state)を判定用の AI モデルに送り、ポリシーがその回答をアクションに変えます。

- スキーマ: [`schema/profile-v1.schema.json`](../../../schema/profile-v1.schema.json)(JSON Schema 2020-12)
- 例: [`examples/profiles/`](../../../examples/profiles/)(英語)
- 検証: `node scripts/validate-profiles.mjs <file-or-directory>...`

## ひと目でわかる例 {#at-a-glance}

次の例は、例のプロファイル [`issue-triage`](../../../examples/profiles/issue-triage.yaml)(英語)を短くしたものです(実際のファイルには `effort` の質問もあり、MCP を通じて AI エージェントからプロファイルが見えるようにしています)。このプロファイルは、新しい Issue をチームに振り分けます。どのチームか AI が確信を持てないときは、人に回します。`$.issue.title` はリクエストの中の位置を指すパス(JSONPath)で、`noul` は、はい・いいえで答える質問です。

```yaml
id: issue-triage
version: 1
title:
  en: Issue triage
  ja: Issue の振り分け
description:
  en: Route a new issue to the right team and flag issues that block work today.
  ja: 新しい Issue を担当チームに振り分け、今日の作業を止めている Issue に印を付ける。
model: clef-flash
fallback_models: [clef]
input:
  - { name: title, path: $.issue.title }
  - { name: body, path: $.issue.body }
questions:
  - name: team
    type: choice
    instructions: Which team should handle this issue?
    criteria:
      - { value: backend, description: "APIs, databases, background jobs" }
      - { value: frontend, description: "Web pages, styles, browser behaviour" }
      - { value: docs, description: "Documentation, tutorials, examples" }
  - name: urgent
    type: noul
    instructions: Does this issue block someone's work today?
    criteria:
      true: Someone cannot continue their work until this is fixed.
      false: Work can continue; this can wait for normal planning.
policy:
  rules:
    - when: "team.p >= 0.85"
      action: auto
  default: review
```

`node scripts/explain-profile.mjs <file>` は、プロファイルを英語または日本語(`--lang ja`)のふつうの文章にして読みます。[文章で読む](#explain)を参照してください。このページの残りでは、すべてのフィールドを説明します。

プロファイルは YAML(または JSON)で書きます。ファイル名は `<id>.yaml` にしなければなりません。

AI アシスタントと一緒にプロファイルを書き、確かめる方法は [authoring.md](../../authoring.md) にあります。

## フィールド {#fields}

| フィールド | 必須 | 意味 |
|---|---|---|
| `id` | はい | URL に使います(`POST /v1/decide/{id}`)。使える文字は小文字、数字、`-` です。 |
| `version` | はい | 整数で、1 から始めます。変更するたびに上げます。各判定には、使ったバージョンが記録されます。 |
| `title`, `description` | はい | 英語(`en`)と日本語(`ja`)のテキストです。エンジニアでない人もプロファイルを読めるようにするためです。 |
| `model` | はい | モデルの ID で、たとえば `clef-flash` です。質問のないプロファイル(ルールだけで、モデルを呼ばない)では `none` にします。 |
| `fallback_models` | いいえ | 主のモデルが失敗したときに、順に試すモデルです。 |
| `input` | いいえ | `{ name, path }` のリストです。クライアントが送った生のペイロードから、簡単な JSONPath(`$.issue.title`)で状態を組み立てます。指定しなければ、リクエストの状態をそのまま送ります。 |
| `questions` | はい | 最大 64 個の質問です(下記を参照)。`requires` のないプロファイルでは 1 個以上必要です。 |
| `requires` | いいえ | ルールが読む以前の判定で、最大 8 個です。`{ name, profile, optional }` の形で書きます([判定のチェーン](#decision-chains)を参照)。 |
| `facts` | いいえ | 判定ごとに調べる空間ファクトで、最大 16 個です。ルールで使います([ファクト](#facts)を参照)。 |
| `policy` | はい | `rules`(上から順に調べ、最初に当てはまったものを使う)と、`default` のアクションです。必要なら `people_check` と `people_answers` も書きます([人による確認と回答](#people-check-and-answers)を参照)。 |
| `mcp` | いいえ | `visible: true` にすると、プロファイルを一覧に出し、MCP から呼べるようにします(既定は false。[mcp.md](../../mcp.md)(英語)を参照)。 |
| `log` | いいえ | `store_state: true` にすると、判定ログに状態全体を残します(既定ではハッシュだけ。[decision-log.md](../../decision-log.md)(英語)を参照)。 |

アクションは `auto`、`review`、または `cancel` のような独自の名前です。[ポリシーの条件](#policy-conditions)を参照してください。

### マップではなくリスト {#lists-not-maps}

質問、選択肢、入力の対応付けは、キーを自由に決めるマップではなく、オブジェクトのリストで書きます。フォームで編集するエディター(たとえば Decap CMS)は、リストはうまく扱えますが、自由なキーのマップは苦手だからです。エンジンが、リストをモデルの API が求めるマップに変換します。

## 質問の型 {#question-types}

3 つの質問の型は、判定に使うモデルの API にそのまま合わせてあります。そのため、プロファイルはどのモデルの API でも動きます。

| 型 | 用途 | プロファイルの `criteria` | モデルの回答 |
|---|---|---|---|
| `noul` | はい・いいえ | 省略できる `{ true: ..., false: ... }` | `noul`: はいの確率(0 から 1) |
| `choice` | 選択肢から 1 つ選ぶ | `{ value, description? }` のリストで、2 から 255 個 | `choice`(最も確率の高い選択肢)、選択肢ごとの `probabilities`、`confidence` |
| `score` | 順序のある基準で段階を評価する | 段階の説明のリストで、低い段階から順に 2 から 10 個 | `score`(確率で重み付けした段階。段階と段階の間の値になることもある)、段階ごとの `probabilities`、`legend`、`confidence` |

質問名に使える文字はモデルの API と同じで、英字、数字、`_`、`.`、`-` です。長さは 100 文字までです。回答は同じ名前で返ります。選択肢の値にも同じ文字を使うため、ポリシーの条件から参照できます(`team.probabilities.customer-support`)。読みやすい説明は `description` に書いてください。

## モデル API の形式(2026-10-06 に確認) {#model-api-format-checked-2026-10-06}

Clef / Clef-flash(Workers AI、`@cf/cloudflare/clef`、`@cf/cloudflare/clef-flash`)と Jev(Typesafe)は、同じ形のリクエストとレスポンスを使います。

```json
{
  "model": "clef-flash",
  "state": "free text, or any JSON value",
  "questions": {
    "team": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": { "backend": "APIs, databases", "frontend": "Web pages" }
    },
    "urgent": { "type": "noul", "instructions": "Does this block work today?" },
    "effort": { "type": "score", "instructions": "How much work?", "criteria": ["Small", "Medium", "Large"] }
  }
}
```

```json
{
  "model": "clef-flash",
  "answers": {
    "team":   { "type": "choice", "choice": "backend", "probabilities": { "backend": 0.93, "frontend": 0.07 }, "confidence": 0.86 },
    "urgent": { "type": "noul", "noul": 0.12 },
    "effort": { "type": "score", "score": 0.4, "legend": { "0": "Small", "1": "Medium", "2": "Large" }, "probabilities": { "0": 0.65, "1": 0.3, "2": 0.05 }, "confidence": 0.5 }
  },
  "usage": { "input_tokens": 120, "output_tokens": 12 }
}
```

例の値は架空のものです。補足を挙げます。

- `noul` の回答にあるのは、はいの確率だけです。`confidence` はありません。
- `choice` の criteria は、選択肢の ID から説明へのマップです。説明は文字列、オブジェクト、配列、`null` のどれでもかまいません。プロファイルでは、今のところ省略できる文字列だけを使えます。
- `score` の criteria は、0 から数えるリストです。確率のキーは、段階の番号を文字列にしたものです。
- モデルの API では、`instructions` もオブジェクトや配列にできます。プロファイルでは、今のところ文字列だけを使えます。
- Clef の上限は、質問が 1 から 64 個、選択肢が 2 から 255 個、段階が 2 から 10 個、画像が 4 枚までです。Jev も、選択肢の上限を同じ 255 個としています。
- 出典: [Clef-flash のモデルページ](https://developers.cloudflare.com/workers-ai/models/clef-flash/)([入力スキーマ](https://developers.cloudflare.com/workers-ai/models/clef-flash/schema-input.json)、[出力スキーマ](https://developers.cloudflare.com/workers-ai/models/clef-flash/schema-output.json))、[Jev のドキュメント](https://docs.typesafe.ai/primitives/choice)。

## エンジンの回答形式 {#engine-answer-format}

エンジンはモデルの回答を同じ形にそろえ(`src/models/normalize.ts`)、`p` が常に `value` の確率になるようにします。

| 型 | `value` | `p` | そのほか |
|---|---|---|---|
| `noul` | P(はい) ≥ 0.5 のとき `true` | P(value) | `yes`: P(はい) |
| `choice` | 最も確率の高い選択肢 | その確率 | `probabilities` |
| `score` | 最も確率の高い段階(0 が最も低い) | その確率 | `score`(重み付けした段階)、`probabilities` |

ポリシーの条件は、これらのフィールドを使います。たとえば `team.p >= 0.85` や `stuck.yes >= 0.9` です(下記を参照)。プロファイルに合わない回答(質問がない、知らない選択肢がある、確率が 0 から 1 の範囲外)は、`model_error` として拒否します。

## ポリシーの条件 {#policy-conditions}

`policy.rules` は上から順に調べます。`when` の条件が真になった最初のルールが、アクションを決めます。どのルールも当てはまらないときは、`policy.default` を使います。

```yaml
policy:
  rules:
    - when: "stuck.yes >= 0.9 and phase.value != 'rolling_back'"
      action: cancel
    - when: "team.p >= 0.85 or team.probabilities.backend >= 0.95"
      action: auto
  default: review
```

条件は、質問のフィールドと値を比べます。

| フィールド | 質問の型 | 型 |
|---|---|---|
| `<question>.value` | すべて | `noul`: true/false、`choice`: 選択肢、`score`: 段階 |
| `<question>.p` | すべて | 数値: `value` の確率 |
| `<question>.yes` | `noul` | 数値: P(はい) |
| `<question>.score` | `score` | 数値: 重み付けした段階 |
| `<question>.probabilities.<option>` | `choice`、`score`(段階の番号) | 数値 |
| `facts.<fact>.<field>` | ファクト([ファクト](#facts)を参照) | そのフィールドの型 |
| `decisions.<name>.<field>` | `requires`([判定のチェーン](#decision-chains)を参照) | そのフィールドの型 |

- 比較には `==`、`!=`、`>=`、`>`、`<=`、`<` を使います。大小を比べられるのは数値だけです。
- 条件は `and`、`or`、`not` と括弧で組み合わせます。`and` は `or` より先に結び付きます。
- 値には、数値(`0.85`)、一重引用符または二重引用符で囲んだ文字列(`'maps'`)、`true`、`false` を使えます。

条件は、プロファイルを検証するときに確かめます。存在しない質問名、その質問の型にないフィールド、その質問にない選択肢、型の違う値どうしの比較があると、検証は失敗します。エンジンは自前のパーサーで条件を評価します。何かをコードとして実行することはありません。

## 文章で読む {#explain}

プロファイルは、英語または日本語のふつうの文章として読めます。プロファイルを承認する人のための機能です。承認する人は、YAML ではなく文章を読みます。

```text
1. If the probability that "danger" is yes is at least 70 %, the action is urgent.
2. If the rank of "flood" is at least 5 and the probability that "danger" is yes is at least 40 %, the action is urgent.
```

ルールはエンジン自身のパーサーで読むため、文章はエンジンが実際にすることを表します。YAML のコメントはプロファイルの一部ではないため、表示しません。質問の文は、書いたとおりに表示します。

- **下書き(ファイル):** `node scripts/explain-profile.mjs <file> [--lang ja] [--json]` を実行します。先にファイルを検証します。無効なプロファイルは説明せず、エラーを並べます。このプロファイルが必要とするプロファイルは、同じディレクトリと、`--with <file-or-directory>` で指定した場所から読みます。
- **公開済みのプロファイル:** `GET /v1/profiles/{id}/explain`(`?lang=ja`、`?version=N`、Markdown がほしいときは `?format=text`)を使います。MCP に表示されるプロファイルでは、MCP のツール `explain_profile` も使えます。呼び出し元が使えない必要なプロファイルは、名前を出しません。それを読むルールは、書いたとおりに表示します。

これは、AI の助けを借りてプロファイルを作る機能(#128)の最初の部分です。アシスタントがプロファイルを下書きし、人は文章の内容を承認します。

## テストケース {#test-cases}

テストケースは、人が期待するアクションを添えた例です。テストケースは、プロファイルごとに 1 つの別のファイルに置きます(たとえば `cases/<id>.yaml`)。プロファイルの隣には置きません。プロファイルのディレクトリにあるファイルは、すべてプロファイルでなければならないからです。テストケースは、ルールが人の望みどおりに動くかどうかを、今も、変更するたびにも示します。

```yaml
profile: road-restriction-check
cases:
  - name: a possible danger in a deep flood zone is urgent
    expect: urgent
    answers: { category: closedWeather, status_matches: true, danger: 0.45, clarity: 2 }
    facts: { flood: { inside: true, rank: 5, class: 3 to 5 m } }
  - name: a real report from last week
    expect: publish
    state: { roadName: { type: Property, value: 県道 12 号 }, description: { type: Property, value: … } }
```

ケースには、**answers** か **state** のどちらかを書きます。

- **answers**: AI の回答を短く書いたものです。ルールが読むときは、`facts` と以前の `decisions` も書きます。モデルを使わずにルールだけを確かめるため、費用がかからず、いつも同じ結果になります。
  - はい・いいえ: `true`、`false`、またははいの確率(`0.45`)
  - 選択: 選択肢(`closedWeather`)、または選択肢ごとの確率(`{ closedWeather: 0.7, other: 0.3 }`)
  - 段階評価: 段階(`2`)、または段階ごとの確率(`{ "1": 0.2, "2": 0.8 }`)。重み付けした段階は、そこから計算します
  - facts: ファクトのフィールド、`missing`、または `{ missing: <reason> }` です。書かなかったファクトは、欠けたものとして扱います。フィールドは、エンジンが返すものに合わせます。最初のフィールドは、何かが見つかったかどうかを表します(`inside`、`found`、`possible`)。それが false のときは、ほかのフィールドを書きません(範囲の外なら rank は 0、class は "")。true のときは、ほかのフィールドも書きます(名前と経路は省略できます)。
  - decisions: `{ action, outcome, reviewed, answers, facts }`、または `missing` です。人が確認しない場合(`reviewed` を省略)、outcome は action と同じなので、どちらか一方を書けば足ります。`reviewed: true` のときは両方を書きます。action と、outcome としての人の回答です。
- **state**: 実際のリクエストです。デプロイ済みの Pointsman で公開している、同じ ID のプロファイルが答えます(そのプロファイルのモデルとファクトを使います)。その回答に、プロファイルのファイルのルールを当てはめます。そのため、変えたしきい値を、公開する前に実際の報告で試せます。回答は、ファイルの質問に合っていなければなりません。新しい質問は、先に公開するか、answers を使ってください。`requires` のあるプロファイルには使えません。

次のように実行します。

```sh
node scripts/test-profile.mjs cases --profiles profiles
# cases with a state too, through a deployment, with a test token:
POINTSMAN_TOKEN=pm_… node scripts/test-profile.mjs cases --profiles profiles --url https://pointsman.example.workers.dev
```

先にプロファイルを検証します。各ケースは、PASS または FAIL を、当てはまったルールを文章にしたもの([文章で読む](#explain)を参照)とともに表示します。実行できないとき(たとえば、プロファイルにない質問への回答がある)は ERROR、そのほかに SKIP もあります。`--lang ja` で日本語にし、`--json` で結果を JSON にします。失敗したケースか、実行できないケースがあると、終了コードは 1 になります。state のあるケースは、`--url` を指定しないとスキップします。

`--url`(https、または localhost なら http)を使うときは、テスト用トークンを使ってください。テスト用トークンの判定は、ログに残りません。ほかのトークンは最初の回答のあとで拒否しますが、その 1 件の判定はログに残り、レビューの待ち行列で人を待つこともあります。state のあるケースは、1 件ごとにモデルを 1 回呼びます。

このリポジトリの例のケースは [examples/cases/](../../../examples/cases/)(英語)にあり、CI で実行しています。テンプレートから作った設定リポジトリでは、`cases/` フォルダーがあれば、検証のワークフローがそれを実行します。

## リプレイ {#replay}

リプレイは、変更したポリシーを公開する前に、デプロイがすでに出した判定にそのポリシーを当てはめたらどう判定していたかを示します。

```text
road-restriction-check: the draft's rules on 200 decisions of version 4 (2026-10-14 01:00 to 2026-10-21 03:00 UTC).
  12 would get another action.
    review → publish: 9
    urgent → review: 3
  To a person: 64 now, 55 with the new rules.
  Of the 30 a person answered, the new rules give the person's answer for 18.
```

最後の 2 行は人に関する数です。今どれだけの判定が人に回っているか(公開中の `people_check` にあるアクション)、新しいポリシー(下書きの `people_check`)ではどれだけ回るか、そして人が答えた判定について、新しいルールだけでその答えをどのくらい出せていたかです。

変わるのは **ポリシー** だけです。ログに残った回答とファクトをそのまま使うため、モデルは呼びません。質問、ファクト、requires は、公開中のバージョンと同じでなければなりません(新しい質問は先に公開し、それまでは[テストケース](#test-cases)を使ってください)。以前の判定は、各判定が残すスナップショットから読みます。読むのは、そのアクション、outcome、人が確認したかどうか、古いルールが読んだ値です。古いルールが残さなかった値を新しいルールが読む場合、その判定はリプレイしません。その判定は **inexact**(正確に再現できない)として数え、ほかのすべての数から除きます(どのルールが読む値も数えるため、inexact に寄せて判断します)。新しいルールが読む回答がログにない判定も、同じように **skipped** として扱います。プロファイルが必要とするプロファイルは、新しい判定のときと同じく、最新のバージョンを読みます。

リプレイするのは、そのバージョンの判定のうち新しいものです。同じ対象についての後の判定で置き換えられた判定も含みます(実際に出された判定だからです)。そのため、1 つの ref が 2 回以上数えられることがあります。

- **下書き(ファイル):** `POINTSMAN_TOKEN=pm_… node scripts/replay-profile.mjs <file> --url <pointsman url>` を実行します(`--limit N` は既定 200、最大 500。ほかに `--version N`、`--lang ja`、`--json`)。先に下書きを検証します。下書きの質問、ファクト、requires も一緒に送り、公開中のものと同じかどうかを確かめます。
- **API:** `POST /v1/profiles/{id}/replay` に `{ "policy": { … } }` を送ります(必要なら `version`、`limit`、`questions`、`facts`、`requires` も送ります)。
- **MCP:** ツール `replay_profile` を使います。

リプレイはログに残った判定を読みます。そのため、トークンはそのプロファイルと、それが必要とするすべてのプロファイルを使えなければなりません。テスト用トークンではリプレイできません。結果が変わった判定は、最大 50 件まで並べます(ID、時刻、ref、変更前と変更後、人の回答)。対象は、そのプロファイルのすべてのクライアントの判定です。件数は、すべての判定を数えたものです。

## 判定のチェーン {#decision-chains}

プロファイルは、同じ報告について以前に出た判定を前提にできます。たとえば、最初の確認と地図による確認の結果を読む、最後のステップです。設計と DMN との対応は、[decision-chains.md](../../decision-chains.md)(英語)にあります。

```yaml
model: none
requires:
  - { name: check, profile: road-restriction-check }
  - { name: evacuation, profile: evacuation-access-check, optional: true }
questions: []
policy:
  rules:
    - when: "decisions.check.outcome == 'reject'"
      action: reject
    - when: "decisions.evacuation.outcome == 'alert'"
      action: urgent
    - when: "decisions.check.outcome == 'urgent'"
      action: urgent
    - when: "decisions.check.outcome == 'publish'"
      action: publish
  default: review
  people_check: []
```

だれも答えないアクションに進むルールは、報告をそこにとどめます。この例の `review` は、最初のステップのレビューがまだ終わっていないことだけを表します。そのレビューに答えると、最後のステップがもう一度実行されます(最初のステップは、深い浸水想定区域を人に回します。examples/profiles/ を参照)。

リクエストでは、以前の判定の ID を名前ごとに指定し、`ref` も添えます。たとえば `{"state": {}, "ref": "report-7", "decisions": {"check": "<decision_id>"}}` です。Pointsman は、それらの判定を判定ログから読みます。呼び出し元が結果を作り出すことはできません。それぞれの判定は、指定した名前のプロファイルのもので、トークンのスコープ内にあり、`ref` が同じで、同じクライアントが出したもので、その報告についてのそのプロファイルの最新の判定でなければなりません(古い判定は置き換えられています)。それ以外の場合は、どれも同じ `400`(`decisions.<name> is not a usable decision`)を返します。そのため、トークンからどの判定が存在するかを探ることはできません。例外が 1 つあります。`optional` の判定が、ここで指定した判定より古い判定をもとに出されていた場合(たとえば、以前の最初の確認に対して出された避難経路の確認)は、実行されなかったものとして除きます。このとき `decisions.<name>.missing` は true になり、回答の `requires` にはその判定が載りません。送ったものと比べてください。必須の判定がこの状態のときは、リクエストを拒否します。テスト用トークンは `decisions` を送れません。

ルールは次のフィールドを読みます。

| フィールド | 型 | 意味 |
|---|---|---|
| `decisions.<name>.missing` | ブール値 | 判定が指定されなかった(`optional` のときだけ)。常にわかる |
| `decisions.<name>.action` | テキスト | Pointsman が決めたアクション |
| `decisions.<name>.outcome` | テキスト | 今有効な結果。レビューが解決していれば人の回答、そうでなければアクション |
| `decisions.<name>.reviewed` | ブール値 | 人がその判定のレビューを解決した |
| `decisions.<name>.answers.<question>.<field>` | 質問と同じ | その判定の回答。レビューが訂正付きで解決されたときは、人が訂正した値 |
| `decisions.<name>.facts.<fact>.<field>` | ファクトと同じ | その判定のファクト |

optional の判定が欠けていると、`missing` 以外のすべてのフィールドが不明になります。欠けたファクトと同じです。判定は、ルールがそれぞれの判定から読んだ値を `requires` に残します([decision-log.md](../../decision-log.md)(英語)を参照)。

プロファイルを検証するときは、プロファイルをひとまとまりとして確かめます。必要なプロファイルはそのまとまりの中になければならず、プロファイルが自分自身を必要としたり、循環を作ったりすることはできません。ルールが読むフィールドと値は、すべて必要なプロファイルに存在しなければなりません(その質問、ファクト、アクション、`people_answers`)。そのため、必要とされるプロファイルを変更して、それを前提にするプロファイルが壊れると、検証が失敗し、壊れたプロファイルの名前を示します。質問に `decisions` という名前は使えません。

同じプロファイル、`ref`、クライアントの新しい判定は、以前の判定を置き換えます。レスポンスには、以前の判定の ID を示す `replaces` が入ります。以前の判定の未解決のレビューは `superseded` として閉じられ、もう解決できません。`requires` のあるプロファイルのレビューを人が解決したあとは、その報告についての新しい判定を拒否します(`409 resolved_by_person`)。人の回答が残ります。新しい判定を出している最中に人がレビューを解決した場合、新しい判定は破棄されたもの(`discarded_at`。決して数えません)としてログに残り、回答は同じ `409` になります。同じ冪等キーで再試行した場合も同じです。

### 人による確認と回答 {#people-check-and-answers}

- `policy.people_check` には、有効になる前に人が確認するアクションを並べます(既定は `[review]`)。これらのアクションになった判定は、それぞれレビューを開きます([reviews.md](../../reviews.md)(英語)を参照)。このとき、decide のレスポンスには `review: {status: pending}` が入ります。
- `policy.people_answers` には、レビューを解決するときに人が出せる回答を並べます(既定は、プロファイルのアクションから `review` を除き、`reject` を加えたもの)。それ以外の回答は拒否します(`400`)。`review` は回答になりません。

```yaml
policy:
  rules:
    - when: "closed.yes >= 0.8"
      action: urgent
  default: review
  people_check: [review, urgent]
  people_answers: [publish, reject]
```

## ファクト {#facts}

言語モデルは幾何が苦手です。座標を渡されても、距離や面積を推測してしまいます。そこで、ファクトは空間演算で計算し、ルールはそれを直接使います。測れるものは、正確に、説明できる形のまま扱えます。背景と測定結果は [spikes/spatial-facts.md](../../spikes/spatial-facts.md)(英語)にあります。ファクトは GitHub からも得られます。プルリクエストの状態を、Pointsman 自身が読みます([GitHub のプルリクエスト](#github-pull-requests))。

```yaml
facts:
  - { name: flood, type: inside, layer: gsi-flood-max, at: $.location.value }
  - { name: shelter, type: nearest, layer: gsi-shelters-flood, at: $.location.value }
  - { name: detour, type: detour, at: $.location.value }

policy:
  rules:
    - when: "facts.flood.rank >= 5 and danger.yes >= 0.4"
      action: urgent
    - when: "facts.detour.extra_m >= 300"
      action: review
    - when: "facts.flood.missing == true"
      action: review
  default: auto
```

| フィールド | 意味 |
|---|---|
| `name` | ルールで `facts.<name>.<field>` として使います。使える文字は質問名と同じです。質問に `facts` という名前や、`facts.` で始まる名前は付けられません。 |
| `type` | `inside`、`nearest`、`detour`(下記)、または [GitHub のファクト](#github-pull-requests)です。ファクトの型は、デプロイで選んだ[ファクトモジュール](../../modules.md)(英語)が提供します。プロファイルで使えるのは、それらのモジュールの型だけです。 |
| `at` | リクエストの状態の中にある GeoJSON の `Point` または `LineString`(WGS 84)を指す JSONPath です。たとえば NGSI-LD の `GeoProperty` なら `$.location.value` です。`input` による対応付けの前に、クライアントが送ったものから読みます。MCP を通じた場合は、クライアントが入力フィールドを自分で送るため、`at` はそれらを読みます(たとえば `$.location`)。 |
| `layer` | `inside` と `nearest` で使います。探すレイヤーです。レイヤー(データの出所、ライセンス、出典の表示)はプロファイルではなく、デプロイごとに設定します。 |
| `mode` | `detour` で使います。`drive`(既定)または `walk` で、車で回るか、歩いて回るかを指定します。 |
| `route` | `detour` で使います。`true` にすると、迂回路(`route`)も返します。既定は `false` です。経路は区間の端から始まって端で終わるため場所がわかり、しかもファクトは、状態を残さない場合でもすべての判定とともに保存されるからです([decision-log.md](../../decision-log.md#what-is-stored)、英語)。 |

| 型 | フィールド | 補足 |
|---|---|---|
| `inside` | `inside`(ブール値)、`rank`(数値)、`class`(テキスト) | レイヤーの範囲の内側にあるかどうかです。`rank` と `class` は範囲を表します。たとえば浸水深の区分です。内側でなければ、`rank` は 0、`class` は空です。 |
| `nearest` | `found`(ブール値)、`distance_m`(数値)、`name`(テキスト) | レイヤーの中で最も近い地物です。見つからなければ、`found` は false で、距離と名前はありません。 |
| `detour` | `possible`(ブール値)、`extra_m`(数値)、`route`(テキスト) | 通行止めの区間を、車または徒歩(`mode`)で迂回するときに余分にかかる距離(メートル)です。`LineString` が必要です。迂回路がなければ、`possible` は false で、`extra_m` はありません。`route` は、区間の一方の端からもう一方の端までの迂回路で、精度 6 のエンコード済みポリライン(Valhalla が送る形)です。アプリが地図に描けるようにするためです。値が入るのは、ファクトで `route: true` を指定し、サーバーが有効な形状を送り、それが 6,000 文字以下のときだけです。ルールからは参照できません。 |

どのファクトにも、`missing`(ブール値)と `reason`(テキスト。欠けた理由で、欠けていないときは不明)があります。

**欠けたファクトを推測することはありません。** ファクトを調べるのに失敗することがあります。状態に場所がないか、ファクトが必要とする種類の場所ではないとき(たとえば、道路の区間を必要とする `detour` に点を渡したとき)は `no_location`、ファクトの提供元がないときは `unavailable`、時間がかかりすぎたときは `timeout`(ファクトごとに 3 秒、`detour` は 8 秒、GitHub のファクトは 5 秒)、エラーのときは `error` です。GitHub のファクトには、ほかに `no_pr` と `stale` の 2 つの理由があります([下記](#missing-github-facts))。欠けたファクトとの比較や、値のないフィールドとの比較は *不明* になります。ルールが当てはまるのは、条件が真のときだけです。

- `false and unknown` は false、`true or unknown` は true、`not unknown` は不明です。
- `facts.<name>.missing == true` は常にわかります。ファクトが欠けた判定を人に回すときに使ってください。
- `facts.<name>.reason` で、調べるのに失敗したのか、そもそも当てはまらないのかを区別できます。`facts.walk.missing == true and facts.walk.reason != 'no_location'` は、本当の失敗だけを人に回し、点を示す報告は回しません。理由の一覧にない `reason` は、プロファイルの検証で拒否します。`reason` の比較だけでは、見つかったファクトには決して当てはまりません(その理由は不明だからです)。`missing == true` の部分を残してください。

ファクトは、モデルが答えている間に調べます。各判定はファクトを返し、判定ログはそれを残します(`facts`)。

```json
"facts": {
  "flood": { "missing": false, "values": { "inside": true, "rank": 5, "class": "3 to 5 m" }, "source": "…" },
  "detour": { "missing": true, "reason": "timeout" }
}
```

モデルはファクトを見ません。スパイク(試作)では、ファクトをモデルの入力に入れると、安心できる内容のときでも `danger` が上がりました。

### ファクトの提供元 {#fact-providers}

空間ファクトは、[ファクトモジュール](../../modules.md)(英語)の `@pointsman/facts-gsi`(`inside`、`nearest`)と `@pointsman/facts-valhalla`(`detour`)が提供します。wrangler の設定の `FACTS_MODE` で、両方を切り替えます(GitHub のファクトには、別の設定 [`FACTS_GITHUB`](#settings) があります)。

| `FACTS_MODE` | ファクト |
|---|---|
| `off`(既定) | なし。すべてのファクトが欠けます(`unavailable`) |
| `mock` | 開発とテスト用の固定の回答。inside(rank 1)、nearest 250 m、迂回路なし |
| `gsi` | 国土地理院(GSI)の公開データ。レイヤーは下記のとおり。`detour` はルーティングサーバー(`FACTS_ROUTING_URL`、下記)があれば答え、なければ `unavailable` |

`gsi` のレイヤーは次のとおりです。

| レイヤー | 型 | データ |
|---|---|---|
| `gsi-flood-max` | `inside` | 想定最大規模の降雨による河川の洪水浸水想定区域(洪水浸水想定区域 想定最大規模)です。ハザードマップポータルサイトのラスタータイルを、ズーム 17 で読みます。`rank` の 1 から 8 と `class` は、ポータルの凡例に従います(0.3 m 未満、0.5 m 未満、0.5 から 1 m、0.5 から 3 m、3 から 5 m、5 から 10 m、10 から 20 m、20 m 以上)。地図が区分を分けていないところでは、範囲の広いほうのラベルを使います。線では、線に沿った最も深い区分になります。 |
| `gsi-shelters-flood` | `nearest` | 洪水の指定緊急避難場所(指定緊急避難場所, 洪水)の GeoJSON タイルです。5 km 以内の避難場所だけを数えます。 |

- どちらも、出典を示せば商用でも無料で使えます。各ファクトの `source` は、データの日付を付けた出典の表示です(たとえば 「ハザードマップポータルサイト」洪水浸水想定区域（想定最大規模）を加工して作成（2025-08-20 時点）)。ファクトを表示するページは、その `source` も表示します。
- タイルは、メモリーと Workers のキャッシュに 1 日保存します。浸水を調べるときは、タイルを 1 枚から数枚(最大 16 枚)読みます。避難場所を調べるときは、5 km 以内のタイルを読みます。点なら約 350 KB のタイルを最大 4 枚、長い線なら最大 9 枚です(キャッシュが空なら約 3 MB。Workers Paid なら問題ありません)。
- `source` の日付は、データのあったタイルのうち最も古い日付です。日付のないタイルが 1 枚でもあれば、"日付不明" になります。
- 凡例にない色があると、推測せずに失敗します(`error`)。そのため、タイルが変わればすぐにわかります。

### 迂回路 {#detours}

`FACTS_ROUTING_URL`([Valhalla](https://github.com/valhalla/valhalla) サーバーの URL。https で、http は localhost のときだけ。認証情報、クエリ、フラグメントは付けられません。`FACTS_MODE=gsi` のときだけ使えます)を設定すると、`detour` のファクトに答えます。通行止めの区間の両端の間の経路を、区間を通る場合と通らない場合について、車または徒歩(`mode`。Valhalla の `auto` と `pedestrian` のコスティング。OpenStreetMap のデータ)で求めます。`source` は、データとルーティングタイルの日付を示します。たとえば `© OpenStreetMap contributors (ODbL), routed with Valhalla (routing data 2026-10-17 時点)` です。日付はタイルのビルド時刻(サーバーの `GET /status` にある `tileset_last_modified`、UTC)で、Worker のインスタンスごとに 1 日保持します。それがないときは日付が `日付不明` になり、5 分後にもう一度 `/status` に問い合わせます。`/status` が失敗したり遅かったり(経路が返ってから 1 秒以上)しても、ファクトが失敗することはありません。
キーが必要なサーバー(Geolonia がホストする Valhalla など)には、Worker のシークレット `FACTS_ROUTING_API_KEY` のキーを、`x-api-key` ヘッダーで送ります。キーはログに残さず、ブラウザーにも送りません。リダイレクトには従いません(キーを別のホストに渡してしまうためです)。3xx の回答は `error` になります。

- 区間全体を、両端からそれぞれ区間に沿って測った 20 m を除いて閉じます。Valhalla は除外範囲に触れる道路をすべて除き、除いた道路からは経路を始められないためです。それで経路が見つからなければ、代わりに区間の中ほどに小さな矩形を置いて閉じます。どちらの端も閉じてはいけません。それができないほど短い区間は、「迂回路なし」ではなく `error` になります。
- Valhalla は道路のエッジ全体を閉じます。そのため、区間を閉じて「経路なし」になっても、「迂回路がない」のか「端の道路も閉じられている」のかを区別できません。この場合は、ほかの失敗と同じく `error` になります。この提供元が `possible: false` を返すことはありません。
- 5 km より長い区間は拒否します(`error`)。
- 区間を通る経路と通らない経路は、同時に問い合わせます。そのため、コールドスタートするサーバー(たとえば AWS Lambda 上のサーバー)でも、待ちは 2 回ではなく 1 回で済みます。そのために、`detour` のファクトには 3 秒ではなく 8 秒の時間があります。
- 接続できなかった呼び出しや、ゲートウェイの回答(502、504)が返った呼び出しは、少し待ってから、その 8 秒以内にもう一度試します。リクエストを拒否したサーバー(キーが違う: 403、リクエストが多すぎる: 429)や、過負荷を伝えたサーバー(503)には、再び問い合わせません。ファクトは `error` になり、Worker のログにステータスが出ます。1 つの迂回路のファクトが行う呼び出しは、最大 6 回です。
- ファクトはモデルが答えている間に調べます。そのため、遅いルーティングサーバーが待ち時間を増やすのは、それが最も遅い部分のときだけです。1 回の decide で最大 8 秒です。

ジオコーディングは、まだ決まっていません(issue #65)。

### GitHub のプルリクエスト {#github-pull-requests}

Pointsman は GitHub からプルリクエストを自分で読めるため、ルールはその状態を使えます。たとえば、下書き(draft)かどうか、どのファイルを変更しているか、必須のチェックは通ったか、です。クライアントが伝えるのは、どのプルリクエストかだけです。「ドキュメントだけの変更」や「チェックは通った」とクライアントが主張することはできません。

```yaml
facts:
  - { name: pr, type: github_pr, at: $.pull_request }
  - name: docs
    type: github_paths
    at: $.pull_request
    paths: ["docs/**", "**/*.md"]
    except: ["**/AGENTS.md"]
  - { name: ci, type: github_checks, at: $.pull_request }
  - { name: level, type: github_property, at: $.pull_request, property: security-level }
```

`at` は、リクエストの状態の中のプルリクエストを指します。

```json
{ "pull_request": { "repo": "octo-org/demo", "number": 7, "head": "<the full 40-character commit id>" } }
```

`head` は、クライアントが見たコミットです。GitHub 上のプルリクエストの head コミットが別のものなら、すべての GitHub のファクトが欠けます(`stale`)。そのため、クライアントが見ていない状態をもとにルールが判定することはありません。

| 型 | フィールド | 補足 |
|---|---|---|
| `github_pr` | `open`、`merged`、`draft`、`wip_title`、`base_is_default`、`author_member`、`author_dependabot`、`fork`、`all_commits_verified`、`author_sole_code_owner`(ブール値)、`files`、`changed_lines`(数値)、`pushed_by_author`(テキスト) | `wip_title`: タイトルに "WIP" という単語があります(`WIP: …`、`[WIP] …`)。`changed_lines`: 追加した行数と削除した行数の合計です。`base_is_default`: プルリクエストの向き先がデフォルトブランチです。`author_member`: 作成者が、リポジトリを所有する組織のメンバーです(個人のリポジトリでは、作成者がその本人です)。GitHub が教えないとき(トークンが非公開のメンバーを見られない、またはメンバーを読む権限がない)は値がありません。`author_dependabot`: 作成者が `dependabot[bot]` アプリです。`fork`: 変更が別のリポジトリから来ています。`all_commits_verified`: すべてのコミットに、GitHub が検証した署名があります。Dependabot のプルリクエストでは、すべてのコミットが Dependabot 自身のものでもなければなりません。つまり、作成者が `dependabot[bot]` アプリで、コミッターが GitHub(署名する `web-flow`)です。そのため、ほかの人が追加して自分の鍵で署名したコミットがあると false になります。コミットが 250 を超えると値がありません(GitHub はそれ以上を一覧にしません)。`pushed_by_author`: だれがコミットをプッシュしたかです。リポジトリのアクティビティの一覧(head ブランチへのプッシュ。1 回のプッシュは、その前の head より後のコミットを持ち込みます)から読みます。すべてのコミットが作成者のプッシュで入ったなら `yes`、1 つでもほかの人のプッシュで入ったなら `no`(たとえば、レビュアーが "Update branch" をクリックした場合)、GitHub が示さず、ほかの人のプッシュもわかっていないなら `unavailable` です(ブランチのアクティビティの一覧で新しいほうから 500 件より古いプッシュ、トークンが見られないフォーク、250 を超えるコミット)。署名では、だれがプッシュしたかはわからないため、これが唯一の情報源です。`author_sole_code_owner`: 変更したすべてのファイル(名前を変えたファイルは両方の名前)について、ベースブランチの `CODEOWNERS` ファイルで、作成者がただ一人のコードオーナーです。チームは、そのメンバーとして所有します。ほかの人、チーム、メールアドレスが所有するファイルがある、所有者のいないファイルがある、`CODEOWNERS` ファイルがない、変更したファイルがない、変更したファイルが 1,000 を超える、のどれかなら false です。`CODEOWNERS` ファイルやチームを読めないと、ファクト全体が欠けます。`CODEOWNERS` ファイルが[1 回のスナップショット](#one-snapshot)にある上限を超えた場合も同じです。 |
| `github_paths` | `any`、`all`(ブール値)、`count`(数値) | 変更したファイルのうち、`paths` に合い、`except` のどれにも合わないものです。`any` はそれが 1 つでもあれば true、`all` は変更したすべてのファイルが合えば true、`count` はその数です。変更したファイルがなければ、`all` は false です。名前を変えたファイルには 2 つの名前があります。`any` ではどちらかが合えば数え、`all` では両方が合うときだけ数えます。 |
| `github_checks` | `required`(数値)、`green`、`pending`、`failed`(ブール値) | head コミットについての、ベースブランチの必須のチェック(ルールセットとブランチ保護)と、ルールセットが必須にしたワークフローです。`green`: すべて通りました(success、neutral、skipped)。`failed`: 1 つが失敗しました。`pending`: 失敗したものはなく、終わっていないか、まだ報告していないものが 1 つあります。必須のチェックがないとき、`green` は false です。パスが同じで、リポジトリか ref が違う必須のワークフローが 2 つあると、この事実は失敗します(`error`)。ワークフローの実行はファイルをパスだけで示すため、1 つの実行が両方に数えられてしまうからです。 |
| `github_property` | `value`(テキスト) | リポジトリのカスタムプロパティ `property` です。設定されていないプロパティは `unset` になります。これはわかっている値で、欠けたファクトではありません。リスト(複数選択)は並べ替えて、カンマでつなぎます。 |
| `github_workflows` | 数(数値)、`detail`(テキスト。ルールでは使えません) | プルリクエストが変更する GitHub Actions のファイルです。[GitHub のワークフロー](#github-workflows)を参照してください。 |
| `github_copilot` | `requested`、`reviewed_head`、`approved_head`(ブール値)、`reviews`(数値) | Copilot のコードレビューです。`requested`: 今 Copilot のレビューが依頼されています。`reviewed_head`: Copilot が head コミットをレビューしました。`approved_head`: Copilot の、結論を出した最新のレビュー(承認、変更の要求、または却下されたもの)が head コミットを承認しています。`reviews`: Copilot がそのプルリクエストで行ったレビューの数です。数えるのは Copilot 自身のボットのアカウント(そのログイン名とアカウント ID)だけです。そのため、人やほかのアプリが代わりになることはできません。Copilot がいなければ、false、false、false、0 です。Copilot はふつうレビューをコメントとして残すため、`approved_head` が true になるのは、Copilot が承認する場合だけです。 |
| `github_app_approval` | `approved_head`、`approved_any`(ブール値)、`reviews`(数値) | GitHub アプリの承認が有効かどうかです。たとえば、GitHub コネクター自身の承認です([github-connector.md](../../github-connector.md#actions))。対象のアプリは、ファクトの `app`(と `bot_id`)で指定します。`approved_head`: そのアプリの、結論を出した最新のレビュー(承認、変更の要求、または却下されたもの)が head コミットを承認しています。却下された承認は GitHub 上で "dismissed" の状態になるため、決して数えません。古いコミットへの承認も数えません。`approved_any`: その最新のレビューが、どれかのコミットを承認しています。`reviews`: そのアプリがプルリクエストで行ったレビューの数です(保留中のものは除きます)。数えるのは、そのアプリ自身のボットのアカウントだけです。アカウントの種類が Bot で、ログイン名が `<app>[bot]` であり、`bot_id` を指定したときはアカウント ID も一致しなければなりません。ほかのアプリ、人、アプリと同じ名前の人は、決して数えません。そのアプリのレビューがなければ、false、false、0 です。 |
| `github_release` | `version_only`(ブール値)、`from`、`to`、`level`(テキスト) | プルリクエストが、リリースのプルリクエストのようにバージョンを動かすだけかどうかです。`version_only` が true になるのは、変更したすべてのファイルが次のどちらかのときです。1 つは変更履歴(`changelogs`、既定は `CHANGELOG.md`。新規または編集で、行を追加しただけ)、もう 1 つは編集したファイルで、変わった各行が、1 つのバージョン文字列(`1.2.3`、`-rc.1` が付いてもよい。アドレスのような、より長いドット区切りの数の一部ではないもの。前に `v` は付かないもの)を別のものに置き換えただけの同じ行であるものです。置き換えはどのファイルでも同じ組で、リリースへの変更(プレリリースへの変更ではない)でなければなりません。`version_files` では、そのような行がバージョンを設定していなければなりません。キーが `version`(大文字小文字は問わない)、`__version__`、または `_VERSION` で終わる名前で、そのあとに `:` か `=` とバージョンだけが続く行です(`"version": "1.2.3",`、`version: 1.2.3`、`export const ENGINE_VERSION = '1.2.3';`)。`package.json` では、その `"version"` の行だけです。さらに head のファイルを読み、変更を取り消したものとの違いが、トップレベルの `"version"` だけでなければなりません(`version` という名前の依存関係は数えません)。そのため、依存関係、URL、最小バージョンが同じ組で動いても数えません。ほかのバージョンのファイルでは行だけを確かめます。入れ子のキーがバージョンを設定する行(TOML の依存関係の表の `version = "1.2.3"`)も数えるため、バージョンの行がそのパッケージ自身のものだけのファイルを指定してください。`version_text_files` では、どの行がバージョンを含んでもかまいません。バージョンを設定する行が、少なくとも 1 つ動いていなければなりません。`from` と `to` はその組で、`level` は `major`、`minor`、`patch` のどれかです。パッチのないファイル(バイナリー、大きすぎるもの)、変更履歴以外の新規・削除・名前を変えたファイル、変更履歴から削除した行、そのほかの変更があると、false、`""`、`""`、`none` になります。だれが変更したかは何も示しません。`github_pr`(作成者、署名、プッシュ)と組み合わせてください。 |
| `github_bump` | `applies`、`only_manifests`、`version_only`、`dev_only`、`registry_changed`(ブール値)、`semver`(テキスト)、`manifest_lines`、`release_age_days`(数値) | プルリクエストが、Dependabot のプルリクエストのように npm の依存関係のバージョンを上げるだけかどうかです。`applies` が true になるのは、変更したすべてのファイルが `package.json`、`pnpm-lock.yaml`、`package-lock.json`(どのフォルダーでもよい)、`.npmrc` のどれかで、`.npmrc` 以外はすべてその場で編集したもの(新規、削除、名前の変更ではない)であり、少なくとも 1 つの `package.json` が依存関係(`dependencies`、`devDependencies`、`optionalDependencies`、`peerDependencies` の中)の指定を変えるときです。ほかのプルリクエスト(GitHub Actions、Docker、pip などの別のエコシステム、コード、ドキュメント、ロックファイルだけ、`yarn.lock`、`pnpm-workspace.yaml`)では `applies` は false になり、ほかのフィールドはすべて最も厳しい値(false、`none`、`registry_changed` は true、0)になります。変更した各 `package.json` は、head コミットで全体を読みます。変更前の内容は、その内容からプルリクエストのパッチを取り消したものです。そのため、変更前も変更後もプルリクエスト自身のものです。`only_manifests`: `.npmrc` を変更していません。`version_only`: `only_manifests` であり、`package.json` のファイルが、もともと持っていた依存関係の指定だけを変え、それぞれの指定が正確なバージョンか、`^` か `~` のあとのバージョンです(`1.2.3`、`^1.2.3`、`~1.2.3`)。`semver`: 上げた依存関係と、ロックファイルが変えたすべてのパッケージのバージョン(推移的なものも含む)を通じて最も大きい段階で、`major`、`minor`、`patch` のどれかです。指定がそれ以外のもの(`>=1.2.3` のような範囲、プレリリース、タグ、URL)の場合、演算子が変わった場合(`^` から `~`)、バージョンが下がった場合は `none` です。キャレットと同じく、先頭のゼロは段階を引き上げます。`0.y.z` からのマイナーの段階は `major`、パッチの段階は `minor` として数え、`0.0.z` からはどの段階も `major` です。そのため、`patch` になるのは `1.0.0` 以降のバージョンだけです。ロックファイルは、パッチを通してだけ読みます。削除された各バージョンを、同じ場所にある同じパッケージの追加されたバージョンと組にします(`pnpm-lock.yaml` では、`packages` と `snapshots` の中のパッケージキーを名前で、インポーターの依存関係のバージョン、パッケージの依存関係のバージョン。`package-lock.json` では、エントリーを `node_modules/...` のパスで、または別のパスに移っただけのパッケージは名前で)。ロックファイルは、次の場合にも `none` になります。削除したバージョンなしに追加したパッケージ(新しい推移的な依存関係)、追加したバージョンなしに削除したパッケージ、1 つのパッケージの複数のバージョンが片側にある場合(迷いなく組にできないため。ピアだけの変更で両側が同じバージョンなら段階はない)、ダウングレード、プレリリースや `x.y.z` でないそのほかのバージョン、パッチが場所を示さないバージョンの行(ハンクのヘッダーにセクションがない、上にキーがない)、`lockfileVersion` やほかのセクション(`overrides`、`settings`)の変更、`pnpm-lock.yaml` のパッケージブロックの中の `version:` フィールドの変更(tarball やリポジトリのパッケージ)、`package-lock.json` でのルートやワークスペース自身のバージョン、または `packages` オブジェクトの外のバージョン(そのため、従来の `dependencies` のコピーを持つロックファイル v1 や v2 は `none` になります。そこにある `"resolved"` の行で、すでに `registry_changed` は true になります)。追加・削除したパッケージの依存関係の行は、それだけでは段階になりません(何がインストールされるかはパッケージキーが示します)。そのほかの変わった行(`resolution`、`engines`、`peerDependencies` の範囲)も段階になりません。`dev_only`: 上げた依存関係がすべて `devDependencies` で変わっています。リポジトリのどの `package.json`(変更したものは変更前と変更後、ほかのものは head)も、上げたパッケージやロックファイルが変えたパッケージを、ほかのセクション(`dependencies`、`optionalDependencies`、`peerDependencies`)に持たず、同梱(`bundleDependencies`、または名前のリストではない同梱のリスト)もしていません。どのロックファイルも、開発用以外で変わったパッケージを示していません。`package-lock.json` では、変わった `node_modules/...` のエントリーで残っているものは、すべてパッチの中で `"dev": true` を示していなければなりません(`devOptional` は dev ではありません。パッチが示さない印は、ないものとして数えます)。`pnpm-lock.yaml` v6(先頭に `/` のあるキー)では、変わったすべてのパッケージが `dev: true` を示していなければなりません。どの `pnpm-lock.yaml` でも、パッケージキーをパッチが示さない変わった行は dev ではないものとして数えます。インポーターの依存関係のバージョンが `devDependencies` 以外のセクションで変わったものは dev ではありません(セクションをパッチが示さないものは、`package.json` の確認に任せます。インポーターは `package.json` だからです)。理解できない行(ほかのセクション、セクションなし)は dev ではないものとして数えます。ほかの `package.json` は、head でのリポジトリのツリー(GitHub の再帰的なツリー)から探し、ほかのすべてが dev だけだと示すときにだけ読みます。GitHub が途中で切ったツリー、50 を超える `package.json`、512 KB より大きい `package.json` があると、ファクト全体が欠けます。JSON オブジェクトでない `package.json` があると false です。限界: `pnpm-lock.yaml` v9 には dev の印がありません。そのため、そのようなロックファイルの中だけで変わるパッケージについて、`dev_only` は、どの `package.json` も、そのパッケージや、それへの依存関係の行が変わるパッケージを `devDependencies` の外に並べていないことを確かめます。実行時の依存関係が、それより多くのパッケージを経由してそのパッケージに届くかどうかは確かめません。`registry_changed`: `.npmrc` を変更した場合、`https://registry.npmjs.org/` 以外の URL、バックスラッシュ(`\u0065` のようなエスケープでフィールドや URL を書けるため)、取得元のキー(`tarball`、`repo`、`commit`、`directory`、`registry`)、プロトコル(`git+`、`git:`、`github:`、`file:`、`link:`、`npm:`、`workspace:` など)を含むロックファイルの行が変わった場合です。`pnpm-lock.yaml` では、固定のバージョンではない `version:` の変更(括弧の中のピアは除く。たとえば別名 `other@1.0.0`)や、`name@version` でないパッケージキーの変更(ロックファイル v9、または先頭に `/` のある v6。v5 のキー `/name/1.0.0`、新しいインポーター)もこれに当たります。`package-lock.json` では、エントリー自身のパッケージのレジストリの tarball ではない `"resolved"` の変更(またはエントリーをパッチが示さないもの)や、`"link"` の変更もこれに当たります。バージョンではなく取得元を指定する指定の変更もこれに当たります。`manifest_lines`: `package.json` のファイル(ロックファイルは除く)で追加した行数と削除した行数の合計です。`release_age_days`: 上げたバージョン(新しい指定のバージョンと、ロックファイルが追加したすべてのバージョン。推移的なものも含む)のうち、最も新しく公開されたものから経った日数(端数は切り捨て)です。npm レジストリ(`https://registry.npmjs.org/<package>` の `time` オブジェクト。GitHub のトークンなしで読みます)から求めます。理解できる指定がなければ 0 です。パッチのない `package.json` やロックファイル(大きすぎるもの)、ファイルに合わないパッチ、30 を超えるそのようなバージョン、公開時刻を答えないレジストリがあると、ファクト全体が欠けます。だれが変更したかは何も示しません。`github_pr`(`author_dependabot`、`all_commits_verified`、`pushed_by_author`)と組み合わせてください。 |

ファクトの設定は次のとおりです。

| フィールド | 対象 | 意味 |
|---|---|---|
| `paths` | `github_paths` | 数えるファイルです。リポジトリの最上位からの glob を 1 から 100 個書きます。`*` は `/` 以外の任意の文字、`**` は任意の数のフォルダー(0 個も含む)、`?` は 1 文字です。`*.md` は `README.md` に合いますが、`docs/a.md` には合いません。すべてのフォルダーを対象にするには `**/*.md` を使います。 |
| `except` | `github_paths` | `paths` に合っても決して数えないファイルです。except のリストが優先されます。 |
| `version_files` | `github_release` | 必須です。バージョンを設定する行が変わってもよいファイルです(glob を 1 から 50 個。書き方は `paths` と同じ)。たとえば `package.json`、`packages/*/package.json`、`src/version.ts` です。 |
| `version_text_files` | `github_release` | どの行がバージョンを含んでもよいファイルです。バージョンを書いたドキュメント用です(glob を 20 個まで)。実行されるファイルは決して指定しないでください。実行されるファイルでは、同じバージョンを含む URL や依存関係が変わっても数えてしまうためです。 |
| `changelogs` | `github_release` | 変更履歴のファイルです(glob を 1 から 20 個。書き方は `paths` と同じ)。これらのファイルには、行を追加することだけが認められます。既定は `CHANGELOG.md` です。ファイルを正確に指定してください。 |
| `property` | `github_property` | カスタムプロパティの名前です。 |
| `app` | `github_app_approval` | 必須です。GitHub アプリのスラッグで、URL `github.com/apps/<slug>` にあるもの(小文字)です。そのボットのアカウントは `<slug>[bot]` です。 |
| `bot_id` | `github_app_approval` | アプリのボットのアカウント ID で、これも確かめます。指定してください。そうすれば、削除されたアプリのスラッグを引き継いだアプリを数えずに済みます。`gh api '/users/<slug>[bot]' --jq .id` で調べられます。 |

**安全のために。** ファクトが欠けたルールは決して当てはまりません。しかし、欠けたファクトのせいで、何かを止める前のほうのルールが当てはまらず、それを許す後のほうのルールが代わりに当てはまることがあります。そのため、まず欠けたファクトを調べてください。そして、何かを許すルール(承認する、レビューを省く)では、前のルールを当てにせず、すべての条件を、わかっている肯定の値として書いてください(`facts.risky.any == false`)。

```yaml
rules:
  - when: "facts.pr.missing == true or facts.docs.missing == true or facts.ci.missing == true"
    action: retry
  - when: "facts.docs.all == true and facts.ci.green == true and facts.pr.all_commits_verified == true"
    action: light
```

例のプロファイル [`pr-docs-check`](../../../examples/profiles/pr-docs-check.yaml)(英語)は、これらの決まりに従っています。

#### 1 回のスナップショット {#one-snapshot}

1 つの判定の GitHub のファクトは、すべてプルリクエストを 1 回読んだ結果から作ります。まずプルリクエストとそのコミットを読み(どちらも `head` と照らし合わせます)、次に、ファクトが必要とする部分(ファイル、メンバーシップ、チェック、プロパティ)だけを、それぞれ 1 回ずつ同時に読みます。ファクトは合わせて 5 秒の時間を共有します。glob は正規表現を使わずに照合するため、長いパターンで判定が遅くなることはありません。

- そのあと `github_bump` は npm レジストリを読みます。これには別に 8 秒の時間があり、全体で 10 秒かかることがあります。レジストリの文書はストリームとして読み、その `time` オブジェクトだけを 64 MB まで残します。変更した各 `package.json` は 512 KB まで読みます。ほかの部分が `dev_only` を示すときは、head でのリポジトリのツリーと、その中のほかの各 `package.json`(最大 50 個、それぞれ 512 KB まで)も読みます。GitHub へのリクエストは最大 51 回増えますが、同じ 5 秒の中で行います。

- ファイルは 1 ページ 100 件で、すべてのページを同時に読みます。変更したファイルが 1,000 を超えるプルリクエストでは、`github_paths` のファクトが欠けます(`error`)。`github_pr` は、それでもファイルの数を知っています。
- コミットは 250 まで読みます(GitHub はそれ以上を一覧にしません)。
- head ブランチへのプッシュ(`pushed_by_author` 用)は、ブランチのアクティビティの一覧から読みます。1 ページ 100 件で、新しい順に、ブランチを作ったプッシュが見つかるまで 1 ページずつ、最大 5 ページ(500 件)読みます。一覧にはマージのようなブランチへのほかの変更も入るため、500 件でも、プッシュは 500 回より少ないことがあります。
  - ブランチを作ったプッシュが見つかれば、それより古いプッシュは、同じ名前の以前のブランチのものとして除きます。
  - 5 ページ以内に見つからなければ、それより古いプッシュは不明のままです。
  - GitHub が示さない後のページのプッシュも、不明のままです。
- チェックは、head コミットにあるものを 300 まで読みます。コミットのステータスとワークフローの実行は 100 までです。
- ルールセットが必須にしたワークフローを数えるのは、GitHub がルールセットのために始めた実行を通じてだけです。リポジトリの同じパスにあるワークフロー(プルリクエストで変更できるもの)を通じては数えません。
- ファイルの一覧はプルリクエストの現在のものなので、そのあとでプルリクエストをもう一度読みます。その間にプッシュがあると、ファクトは `stale` になります。
- 同じ名前のチェックとコミットのステータスの結果が食い違うときは、厳しいほうの結果を使います。
- レビューと会話のコメントは、1 ページ 100 件で 1 ページずつ読み、それぞれ 500 件未満までです。500 件以上あると、それを必要とするファクトが欠けます(`error`)。読んだあとは、ファイルの一覧のときと同じく、プルリクエストをもう一度読みます。その間にプッシュがあると、それらのファクトは `stale` になります。レビューの依頼とレビューのスレッドは、GitHub の GraphQL API から 1 回のクエリで読みます(`head` と照らし合わせます)。依頼は最大 100 件(それを超えると `error`)、スレッドは最大 100 件(それを超えると、スレッドの数は値がありません)です。
- head コミットのステータスの履歴(最新のものだけでなく、すべてのステータス)は 300 件未満までです。
- `CODEOWNERS` は最大 128 KiB で、各パターンは最大 1,024 文字です。変更したすべてのファイルをそのパターンと照合する処理は、5,000 万ステップまでに制限しています。`build/` のようなフォルダーのパターンを 1,000 個書いたファイルと 2,000 個のファイル名の照合でも、この上限には遠く届きません。どれかの上限を超えると、`github_pr` は欠けます(`error`)。所有者を推測することはありません。GitHub 自身は、3 MB を超える `CODEOWNERS` ファイルを無視します。

#### 欠けた GitHub のファクト {#missing-github-facts}

| 理由 | いつ |
|---|---|
| `no_pr` | `at` にプルリクエストがありません。`repo` は `owner/name`、`number` は 1 以上の整数、`head` は 40 文字の完全なコミット ID でなければなりません。GitHub には何も送りません。 |
| `stale` | GitHub の head コミットが `head` ではありません。このとき、その判定の GitHub のファクトはすべて `stale` になります。変更したファイルを読んでいる間にプッシュがあると、ファイルを使うファクト(`github_paths` と、`author_sole_code_owner` のためにファイルを読む `github_pr`)が `stale` になります。レビューやレビューのスレッドを読んでいる間のプッシュも同じです(`github_copilot`、`github_app_approval`)。`github_checks` はコミット ID で読むため、後からのプッシュでは変わりません。 |
| `unavailable` | GitHub の提供元がない(`FACTS_GITHUB` が off)か、トークンがリポジトリを見られません(GitHub が 404 か 403 を返す、またはアプリがそこにインストールされていない)。 |
| `timeout` | GitHub が 5 秒より長くかかりました。 |
| `error` | そのほかのすべてです。GitHub のエラー(5xx)、レート制限、リダイレクト(従いません。トークンを別の場所に渡してしまうためです)、形の違う回答、多すぎるファイルやチェックです。 |

#### 設定 {#settings}

wrangler の設定の `FACTS_GITHUB` で決めます。

| `FACTS_GITHUB` | GitHub のファクト |
|---|---|
| `off`(既定) | なし。すべての GitHub のファクトが欠けます(`unavailable`) |
| `mock` | 開発とテスト用の固定の回答。作成者はメンバーで、すべてのコミットを自分でプッシュし、ただ一人のコードオーナーではない、開いたプルリクエスト。変更したファイルは 1 つ(10 行)で、どのパスのリストにも合う。署名付きのコミット。必須のチェックが 1 つあり、通っている。どのプロパティも `unset`。変更したワークフローのファイルが 1 つあり、指摘はない。Copilot のレビューはない |
| `token` | Worker のシークレット `FACTS_GITHUB_TOKEN` で読みます |
| `app` | GitHub アプリとして読みます。`FACTS_GITHUB_APP_ID` と、Worker のシークレット `FACTS_GITHUB_APP_PRIVATE_KEY`(GitHub から受け取る PEM ファイル)を使います |

- `FACTS_MODE` と `FACTS_GITHUB` は別々の設定です。`FACTS_MODE: mock` は GitHub のファクトに答えず、`FACTS_GITHUB: mock` は空間ファクトに答えません。
- `app` では、Pointsman はリポジトリに対するアプリのインストールを見つけ、インストールトークンを作ります。トークンは、期限が切れる(1 時間後)5 分前まで保持します。トークンを作ることだけが、読み取り以外のリクエストです(GraphQL のクエリは POST で送りますが、読むだけです)。トークンは権限を絞ってあり、ファクトが使う権限だけを読み取り専用で持ちます。それでも、アプリには読み取りの権限だけを与え、書き込みをするものには別のアプリを使ってください([github-connector.md](../../github-connector.md#the-two-github-apps))。アプリは非公開のリポジトリのチェックを読めますが、fine-grained トークンは読めません。
- `FACTS_GITHUB_IGNORE_CHECK`: 自分の Pointsman のクライアントがプルリクエストに追加するチェックの名前です。このチェックは必須のチェックとして決して数えないため、Pointsman が自分自身を待つことはありません。これはプロファイルのフィールドではなくデプロイの設定なので、プロファイルが本物のチェックを外すことはできません。
- トークンと鍵はログに残しません。ファクトの `source` は、プルリクエストだけを示します。たとえば `GitHub octo-org/demo#7 at 1a2b3c4` です。

fine-grained トークンまたはアプリの権限(すべて読み取り)は次のとおりです。

| 権限 | 用途 |
|---|---|
| Pull requests | `github_pr`、`github_paths`、`github_workflows`、`github_release`、`github_bump`、`github_copilot`(レビュー、レビューの依頼、レビューのスレッド、会話のコメント)、`github_app_approval`(レビュー) |
| Contents | プルリクエストのコミット、そのブランチへのプッシュ、`CODEOWNERS`、`github_workflows` が読むファイル、`github_bump` と `github_release` が読む `package.json` のファイル |
| Metadata | 常に必要(どのアプリにもあります) |
| Checks(アプリだけ)、Commit statuses | `github_checks`。コミットのステータスは、スナップショットを読むほかのモジュールのファクトにも使います |
| Actions | `github_checks`。ルールセットがワークフローを必須にしているとき |
| Custom properties | `github_property` |
| Organization: Members | メンバーシップを隠しているメンバーについての `author_member`、`CODEOWNERS` にあるチームのメンバー |

fine-grained トークンには Checks の権限がありません。この権限があるのはアプリだけです。トークンでは指定しないでください。

必須のチェックは、ブランチのルールとその保護から読みます。リポジトリを読めるだれにでも GitHub が示すものなので、管理の権限は要りません。

### CodeRabbit のレビュー {#coderabbit-reviews}

モジュール `@pointsman/coderabbit` は、[CodeRabbit](https://coderabbit.ai) がプルリクエストで何をしたかを、GitHub のファクトと同じスナップショットを通じて GitHub から読みます。

```yaml
facts:
  - { name: coderabbit, type: coderabbit, at: $.pull_request, not_reviewed: ["**/pnpm-lock.yaml", "**/dist/**"] }
```

| フィールド | 意味 |
|---|---|
| `installed` | CodeRabbit がリポジトリで動いています。このプルリクエストにレビュー、コメント、ステータスを残したか、ほかの新しい 5 つのプルリクエストのどれかの head にステータスを残しています。判断できないとき(ほかのプルリクエストがない)は値がありません。 |
| `ignored` | 説明文に `@coderabbitai ignore` があります。説明文の中の CodeRabbit 自身の要約ブロックの外にあるものだけを数えます(除くのは、開始から終了のマーカーまでのブロック全体だけです。開始のマーカーだけがあっても、その後ろの文章は数えます)。 |
| `reviewed_any`, `reviewed_head` | CodeRabbit がプルリクエストのどれかのコミットをレビューしました。head コミットをレビューしました(head へのレビュー、またはレビューしたことを示す head への CodeRabbit のステータス: "Review completed"、"Review approved"、または承認コマンドによるもの)。 |
| `in_progress` | head への CodeRabbit の最新のステータスが "Review in progress" です。 |
| `approved_head`, `changes_requested` | CodeRabbit の、結論を出した最新のレビュー(承認、変更の要求、または却下されたもの)が head コミットを承認しています。変更を求めています。 |
| `rebase_only` | head が、CodeRabbit が承認したコミットとまったく同じ変更を持っています。プルリクエストのベースコミットと比べて、各ファイルのパッチが前後の文脈の行まで 1 行ずつ同じで、違ってよいのはハンクの行番号だけです(`git patch-id` と同じ考え方)。そのため、同じ編集でも別の場所なら新しい変更になり、編集の隣の行が変わったリベースでは、もう一度レビューが必要になります。承認がないとき、または承認が head に対するものなら false です。変更を比べられないとき(バイナリーファイルのようにパッチのないファイル、ファイルの一覧がない、300 以上のファイル)は値がありません。 |
| `unresolved_threads` | CodeRabbit が始めた、未解決のレビューのスレッドの数です。スレッドが 100 を超えると値がありません。 |
| `outside_diff_findings` | テキストのある CodeRabbit の最新のレビューに、差分の外の指摘があります(これらはスレッドになりません)。テキストのない承認では取り消されません。 |
| `billable_files`, `price_stated` | レビューで課金されるファイルの数です。CodeRabbit がこの head について数を示していれば、その数です(`price_stated` が true)。示していなければ、変更したファイルから `not_reviewed` を除いた数です(名前を変えたファイルは 1 つと数えます)。数がこの head についてのものとみなすのは、CodeRabbit のコメントが、対象の範囲の終わりとして head を示しているときだけです("between <commit> and <head>")。CodeRabbit は要約をその場で編集するため、編集した時刻では判断できないからです。 |

数えるのは CodeRabbit 自身のアカウントだけです。つまり、そのボット(ログイン名 `coderabbitai[bot]` とそのアカウント ID)のレビューとステータス、その GitHub アプリを通じて作られたボットのコメントです。同じテキストを書いたほかの人や、同じログイン名のアカウントは数えません。書き込み権限のある人は、ボットのコメントを編集できます。CodeRabbit 以外のだれかが CodeRabbit のコメントやレビューを最後に編集していた場合、ファクト全体が欠けます(`error`)。編集者を読めない場合(コメントやレビューが 100 を超える場合)や、編集者といっしょに読んだテキストがコメントやレビューそのもののテキストと違う場合(2 回の読み取りのあいだに編集された場合)も同じです。

GitHub のファクトと同じく、このファクトも欠けることがあります(`error`、`stale`、`unavailable`、`timeout`)。さらに、レビュー、コメント、head のステータス、レビューのスレッド、ほかのプルリクエスト、比較のどれかを読めないときも欠けます。

ほかに 3 つの型が、このクライアントが同じプロファイルで出した以前の判定も、直近 24 時間分(spend では `pr_hours` と `window_hours` の長いほう)読みます([modules.md](../../modules.md#facts-from-the-decision-log)、英語)。これらの型は、プルリクエスト(`pull_request`、`owner/repo#n` の形)とその作成者(`author`)を、人が読むためのテキストとして値に書きます(ルールでは使えません)。後の判定がそれを見つけられるようにするためです。その期間の判定が 999 件を超える場合、ログを読めない場合、テスト用トークンの場合(`no_log`)は、これらのファクトが欠けます。

```yaml
facts:
  - { name: budget, type: coderabbit_budget, at: $.pull_request }
  - { name: queue, type: coderabbit_queue, at: $.pull_request, waiting: [wait, queue] }
  - { name: spend, type: coderabbit_spend, at: $.pull_request, pay_actions: [pay], usd_per_file: 0.25, not_reviewed: ["**/pnpm-lock.yaml"] }
```

**`coderabbit_budget`**: プルリクエストの作成者の、CodeRabbit のレビューの予算です。CodeRabbit の上限は開発者ごとで、プルリクエストを開いた人に付いて回ります。そのため、作成者についての回答だけを数えます。具体的には、このプルリクエストにある CodeRabbit の上限の通知、返信の前 10 分間のコマンドがすべて作成者のものだったときの CodeRabbit の返信、このクライアントの判定に残る、作成者のほかのプルリクエストでの読み取りです。ほかのだれか(アプリも含む)のコマンドへの返信かもしれないものは、その人の予算についてのものなので、決して数えません。

| フィールド | 意味 |
|---|---|
| `known` | 読み取りがあり、その待ち時間が終わっておらず、その中で無料のレビューの数が示されたのが 1 時間以内です。 |
| `available` | 示された無料のレビューの数です。数が示されていない、待ち時間だけが示されている、何もわからない、のどれかなら 0 です。 |
| `wait_stated`, `wait_minutes` | CodeRabbit が待ち時間を示しました。残りの分数です(示されていなければ値がありません)。 |
| `allowance_per_hour` | CodeRabbit が最後に示した、1 時間あたりのレビューの数です(一度も示していなければ値がありません)。 |
| `observed_minutes_ago` | 読み取りから経った分数です(読み取りがなければ値がありません)。 |
| `asked_minutes_ago` | 作成者がここで最後に `@coderabbitai rate limit` と尋ねてから経った分数です(一度も尋ねていなければ値がありません)。 |
| `taken_by_other_pr` | 読み取りのあとで、作成者のプルリクエスト(別のもの、または以前の head でのこのプルリクエスト)が、このプロファイルで `review_actions`(既定は `review`)のどれかの判定を受けました。その無料のレビューは、もう使われたかもしれません。 |

**`coderabbit_queue`**: 作成者のほかのプルリクエストのうち、このプルリクエストより先に無料のレビューを待っているものです。プルリクエストが待っているとみなすのは、このプロファイルでの最新の判定が `waiting`(必須)のアクションのどれかで、それが `max_age_minutes`(既定は 120)以内に出されたときです。先に待ち始めたものが前に並びます。`ahead` はその数です。`wait_minutes` は、CodeRabbit の待ち時間に、前に並ぶプルリクエスト 1 つにつき 1 枠(60 ÷ 1 時間あたりのレビューの数)を足したものです。前に並ぶプルリクエストより無料のレビューのほうが多ければ 0、計算できないとき(予算がわからない、1 時間あたりの数が示されていない)は値がありません。読み取りのあとで使われた無料のレビュー(予算と同じく、`review_actions` のどれかの判定)は、もう無料のレビューとして数えません。

**`coderabbit_spend`**: 有料のレビューの費用です。

| フィールド | 意味 |
|---|---|
| `price_usd` | このレビューの価格です。CodeRabbit がこの head について示した価格、示していなければ課金されるファイルの数(`coderabbit` と同じ)に `usd_per_file` を掛けたものです。 |
| `per_pr_usd_after` | 直近 `pr_hours`(既定は 48、最大 168)のこのプルリクエストへの支払いに、このレビューを足したものです。 |
| `per_window_usd_after` | 直近 `window_hours`(既定は 5、最大 24)のすべてのプルリクエストへのこれまでの支払いに、このレビューを足したものです。 |
| `paid_for_head` | この head について有料のレビューのコマンド(`@coderabbitai review --use-credits`)があります。head をプッシュしたあとに、作成者、組織のオーナーかメンバー、または `payer_apps` にあるアプリ(ID で指定)が書いたもので、そのあと 10 分以内に CodeRabbit がその head のレビューを始めたか終えたものです。 |

支払いは、このクライアントがこのプロファイルで出した判定のうち、`pay_actions` のアクションになったものから数えます。金額は、その判定の spend のファクトが記録した `price_usd` で、head ごとに 1 回(最も高い価格で)数えます。この head についての以前の判定は同じレビューなので、2 回は足しません。この head は、以前の価格と今の価格の高いほうで 1 回だけ数えます。支払いの判定は予約です。エンジンはそれが実行されたかどうかを知らないため、数えます。プルリクエストについては、そのあとに有料のレビューのコマンドが書かれない限り、24 時間で数えるのをやめます。この方法は多めに数えることはあっても、少なめに数えることはありません。

設定: `FACTS_CODERABBIT` を `on` にすると、GitHub のモジュールの設定(`FACTS_GITHUB` の `token` または `app`。そのため `@pointsman/github` も選んでください)で GitHub を読みます。`mock` は固定の回答を返します(CodeRabbit は動いていて、まだレビューしていない。課金されるファイルは 1 つ)。`off`(既定)では、ファクトが欠けます。権限は GitHub のファクトと同じで、Pull requests、Contents(コミットを比べるため)、Commit statuses です。

### GitHub のワークフロー {#github-workflows}

`github_workflows` のファクトは、プルリクエストが変更する GitHub Actions のファイルを読みます。プロファイルはそれをもとに、その変更をマージしても安全かどうか(通す、直す、人が確認する)を判定できます。これもほかと同じ GitHub のファクトで、スナップショット、`head` の確認、[欠けた理由](#missing-github-facts)は同じです。クライアントが送るのはプルリクエストだけで、ファイルは Pointsman が自分で読みます。

```yaml
facts:
  - name: wf
    type: github_workflows
    at: $.pull_request
    pin_exempt: ["example-org/*"]
```

例のプロファイル [`workflow-check`](../../../examples/profiles/workflow-check.yaml)(英語)がこのファクトを使っています。

**読むもの。** 次の範囲にある変更したファイルを、head コミットとベースの先端(プルリクエストの `base.sha`)で読みます。

- ワークフロー: `.github/workflows/*.yml` と `*.yaml`(サブフォルダーの中のものは除きます。GitHub はそれらを実行しないからです)
- ローカルのアクション: head かベースで `action.yml` または `action.yaml` があるフォルダーの中の、すべてのファイル(その隣にある `index.js`、`Dockerfile`、スクリプトも含みます)。フォルダーは、コミットのファイルツリーから見つけます
- zizmor と pinact のスキャナーの設定: `zizmor.yml`、`.github/zizmor.yml`、`.pinact.yml`、`.github/pinact.yml`、`.github/.pinact.yml`。それぞれ `.yaml` の場合も含みます

ワークフローと `action.yml` のファイルは解析します。ほかのファイルは数えるだけです。何も実行せず、`${{ }}` の式は小さなトークナイザーで読むだけで、評価はしません。範囲の外に名前を変えたファイルは、削除したものとして数えます。

**フィールド。** ルールのフィールドは単一の値なので、このファクトはすべてのファイルを通して数えます。`detail` 以外のフィールドはすべて数値です。

| フィールド | 数えるもの |
|---|---|
| `changed`, `removed` | 範囲の中で変更したファイル(追加、変更、名前の変更)と、削除したファイル |
| `unparsed` | 解析できなかった、上限を超えた、または予期しない形をしていたファイル([下記](#parser-limits)) |
| `bytes` | head での、変更したファイルの大きさ |
| `privileged` | ベースのリポジトリの文脈で、そのシークレットと書き込みのトークンを持って動くトリガー(`privileged_triggers`)がある、変更したワークフロー |
| `privileged_new` | ベースでのバージョンにはない特権のトリガー(新しいファイルなら、すべて) |
| `head_checkout` | ベース以外のコードをチェックアウトするかもしれない特権のジョブ。許可リスト方式で、チェックアウトがベースとみなされるのは、`repository` が空、リポジトリ自身、または `${{ github.repository }}` で、かつ `ref` が空、固定のブランチやタグ(`refs/pull/…` やコミット ID ではない)、または `base_refs` にある式 1 つだけのときです。`steps.*.outputs`、`env`、`needs` から来る ref は数えます。コードを取ってくるかもしれないスクリプトも数えます。`git` という単語と `checkout`、`switch`、`fetch`、`pull`、`clone` などを含む `run:`(行の継続をまたいでも)、`checkout`、`clone`、`download` を伴う `gh`、アーカイブを取ってくる `curl` や `wget`、プログラムを実行する `github-script` です。この部分はできる範囲での検出です。スクリプトは、どんな単語のリストにもかからない方法でコードを取ってこられるため、`privileged` の変更はすべて人に回してください。 |
| `pwn_request` | そのうち、リポジトリの内容を実行するかもしれないステップを持つジョブ。`run:`、ローカルのアクション、`inert_actions` にないアクションです。ジョブの中のどこにあっても数えます。チェックアウトより前にあっても数えます。チェックアウトの前に動いたアクションも、あとでチェックアウトしたコードの中で `post:` のステップを実行するからです。 |
| `artifact_in_privileged` | アーティファクトをダウンロードする特権のジョブ。`actions/download-artifact`(同じ実行のものも数えます。別のジョブがチェックアウトしたコードから作ったかもしれないためです)、`dawidd6/action-download-artifact`、`run:` の中の `gh run download` や `artifacts` という単語、`github-script` の `script:` の中のアーティファクトの API です |
| `remote_reusable` | ほかのリポジトリの再利用可能なワークフローを呼ぶ特権のジョブと、`secrets: inherit` のあるすべてのジョブ |
| `secrets_new` | どのワークフローでも、ジョブが head では読むがベースでは読まないシークレット(`if:` やワークフローの `env:` の中も含みます。`toJSON(secrets)` は新しいシークレット 1 つとして数えます) |
| `injection` | `run:` や `github-script` の `script:` の中の、信頼できない式。`safe_contexts` にない、`github` やその下へのすべての参照と、`env`、`steps`、`needs`、`inputs` へのすべての参照です(受け渡された値で、`github.event` から来ているかもしれないためです)。むき出しの `github`、`*`、添え字(`github['event']` は `github.event`)、関数の中の参照(`toJSON(github.event)`)、読めない式も数えます。値は `env:` を通して渡し、変数を引用符で囲んでください。ファイルを通してスクリプトに届く値は数えません。 |
| `permissions_missing` | ジョブにもワークフローにも `permissions:` がないジョブ(リポジトリの既定が適用されますが、ファイルからはわかりません) |
| `write_all` | ジョブの中の `write-all` と、ワークフローの階層に書き込みのスコープがあるワークフロー |
| `write_new` | ジョブが head では持ち、ベースでは持たない書き込みのスコープ(ジョブのブロックはワークフローのブロックを置き換えます) |
| `persisted` | git のステップ(`git push`、`commit`、`tag`、`fetch`、`pull` か `gh` を含む `run:`、または `git_actions` にあるアクション)がないジョブの中で、`persist-credentials: false` のない `actions/checkout`。式は有効として数えます。 |
| `unpinned` | 40 文字のコミット ID に固定していない `uses:`(`pin_exempt` にあるアクションは固定しなくてかまいません)と、`@sha256:` のダイジェストのないイメージ(`docker://…`、`container:`、`services:`、Docker のアクションの `image`)。ローカルの `./` のアクションは数えません。 |
| `suppressions_new` | head にあってベースにない `zizmor: ignore` の行(移動したものも数えます)と、変更または削除したスキャナーの設定 |
| `local_unresolved` | 変更したローカルのアクション(フォルダーごとに 1 回。解析するのは `action.yml` だけで、コードは解析しません)、変更した再利用可能なワークフロー(`workflow_call`。その呼び出し元は読みません)、ローカルの再利用可能なワークフローを呼ぶ特権のジョブ(そのワークフローは読みません) |
| `detail` | テキスト。最初の 20 件の指摘を、ファイルと行とともに示します。人とログのためのものです。`detour` の `route` と同じく、ルールからは読めません。 |

ワークフローのファイル、アクションのファイル、ジョブの ID は名前で比べます。ベースにあるファイルとは、同じ名前のファイル、または名前を変えたファイルの以前の名前のファイルです。解析できないベースのバージョンは、ないものとして数えます。そのため、その中のものはすべて新しいものになります。

**設定。** どれも既定値に追加するリストです。プロファイルから既定値を取り除くことはできません。

| フィールド | 既定 | 書くもの |
|---|---|---|
| `privileged_triggers` | `pull_request_target`、`workflow_run`、`issue_comment`、`issues`、`discussion`、`discussion_comment`、`fork`、`watch`、`gollum` | トリガーの名前 |
| `inert_actions` | `actions/checkout`、`actions/upload-artifact` | ワークスペースの内容を実行しないとわかっているアクション。`owner/repo`、またはその所有者のすべてのリポジトリなら `owner/*`(その所有者に完全に一致するものだけ。`example-org/*` は `example-org-x/…` を含みません) |
| `safe_contexts` | `github.sha`、`github.run_id`、`github.run_number`、`github.run_attempt`、`github.job`、`github.event_name`、`github.repository`、`github.repository_id`、`github.repository_owner`、`github.repository_owner_id`、`github.server_url`、`github.api_url`、`github.workspace`、`github.event.number`、`github.event.pull_request.number`、`github.event.issue.number`、`github.event.pull_request.head.sha`、`github.event.pull_request.base.sha`、`github.event.workflow_run.id`、`github.event.workflow_run.head_sha` | スクリプトの中で使っても安全な `github.*` の正確なパス(小文字)。数値、ID、コミット ID です |
| `base_refs` | `github.sha`、`github.ref` | チェックアウトの `ref` でベースを指す式(既定のトリガーでは、どちらもベースブランチかデフォルトブランチです) |
| `git_actions` | なし | チェックアウトの git の認証情報を必要とするアクション |
| `pin_exempt` | なし | コミットに固定しなくてよいアクション。たとえば、メジャーのタグで使う自分の組織のアクションです |

#### パーサーの上限 {#parser-limits}

ファイルを書くのはプルリクエストの作成者です。次のどれかに当たるファイルは `unparsed` になるため、プロファイルはそのファイルを人に回せます。スキップすることはありません。また、`unparsed` のファイルは、ほかの項目では何も数えません。

- YAML 1.2 のコアスキーマに従います。ディレクティブ(`%YAML`)、独自のタグ、マージキー(`<<`。GitHub も受け付けません)、重複したキーは使えません。キーはテキストでなければならず、1 つのファイルには 1 つの文書だけです。
- エイリアスは 1 ファイルあたり最大 100 個、エイリアスを展開したあとの値は最大 50,000 個です。
- 解析するファイルは、1 つのプルリクエストにつき最大 50 個です(残りは `unparsed` になり、読みません)。1 ファイルは 256 KB までです。UTF-8 のテキストでないファイルも `unparsed` になります。
- 意味のあるキーでの予期しない形も `unparsed` になります。対象のキーは `on`、`jobs`、`steps`、`permissions`、`uses`、`with`、`run`、`secrets`、`container`、`services`、`runs` です。たとえば、リストでない `steps`、`uses` と `run` の両方を持つステップ、`uses` の中の式、閉じていない `${{`、GitHub が小文字で読むキーを別の書き方にしたもの(`Run:`)です。
- `with:` の下の入力は、アクションが読むのと同じく、大文字小文字を区別せずに読みます(`Persist-Credentials` は `persist-credentials` です)。

`github_paths` と同じく、変更したファイルが 1,000 を超えると、ファクトが欠けます(`error`)。GitHub が途中で切ったリポジトリのツリー(非常に大きいリポジトリ)でも同じです。

**まだ対応していないこと。** 固定したコミットが、アクションのフォークだけでなく、アクションのリポジトリ自身のものかどうか(なりすましのコミット)は確かめません。ローカルの再利用可能なワークフローと、ローカルのアクションのコードは読みません。これらは人に回ります(`local_unresolved`)。ワークフローがアクションのフォルダーの外で呼ぶスクリプト(`run: ./scripts/deploy.sh`)は範囲に入りません。そのようなスクリプトだけを変更しても、指摘は出ません。プルリクエストごとにファイルツリーを 2 つ読むため、GitHub のツリーの上限(100,000 エントリー)に近いリポジトリでは、より多くのメモリーが要ります。GitHub が途中で切ったツリーでは、ファクトが欠けます。

**プロファイルのための安全の決まり。** どの GitHub のファクトとも同じです。ファクトが欠けたら「まだ判定しない」(`retry`)にして、決して通さないでください。通すルールでは、すべての条件をわかっている値として書いてください。AI の回答は結果を厳しくする方向にだけ使います(変更を人に回すことはできても、通すことはできません)。ファイルとプルリクエストのテキストは、その作成者が書いたものだからです。
