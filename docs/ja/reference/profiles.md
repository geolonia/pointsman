---
title: プロファイルの概要
description: 判定プロファイルに何を書くかを実際の例で示し、各部分の詳しい説明への入り口をまとめます。
sidebar: { order: 5 }
---

**プロファイル**は、1 種類の判定を表します。AI が答える質問、Pointsman が調べるファクト、その 2 つをアクションに変えるルールを書きます。プロファイルは YAML ファイルで、自分たちの設定用リポジトリに置きます。変更するたびにバージョンの番号を上げます。

## 例

例のプロファイル [`issue-triage`](../../../examples/profiles/issue-triage.yaml) を短くしたものです(実際のファイルには `effort` の質問もあり、MCP で AI エージェントから使えるようにする設定も入っています)。新しい Issue をチームに振り分け、どのチームか AI が確かでないときは人に回します。`$.issue.title` はリクエストの中の位置を指すパス(JSONPath)で、`noul` は「はい・いいえ」で答える質問です。

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

## 各部分

| 部分 | 内容 | 詳細 |
|---|---|---|
| `id`、`version` | API で使うプロファイルの名前(`POST /v1/decide/issue-triage`)とバージョンです。変更するたびにバージョンを上げます。 | [Fields](../../profile-format.md#fields) |
| `title`、`description` | 何を判定するプロファイルかを、承認する人のために英語と日本語で書きます。 | [Fields](../../profile-format.md#fields) |
| `model`、`fallback_models` | 答える AI モデルと、失敗したときに試すモデルです。 | [Models](../../models.md) |
| `input` | リクエストのどの部分を AI に見せるかです。 | [Fields](../../profile-format.md#fields) |
| `questions` | AI が答える質問です。`noul`(はい・いいえ)、`choice`(選択肢から 1 つ)、`score`(段階)があります。 | [Question types](../../profile-format.md#question-types) |
| `facts` | Pointsman 自身が調べるデータです(この例にはありません)。 | [Facts](../../profile-format.md#facts)、[ファクトの型](fact-types.md) |
| `requires` | この判定が前提にする、以前の判定です(この例にはありません)。 | [Decision chains](../../profile-format.md#decision-chains) |
| `policy` | ルールです。上から順に調べ、最初に当てはまったルールでアクションが決まります。どれも当てはまらないときは `default` になります。 | [Policy conditions](../../profile-format.md#policy-conditions) |

## 文章で読む

`explain-profile` は、承認する人のためにプロファイルをふつうの文章に直します。Pointsman のリポジトリをチェックアウトし、Node.js 24 で実行します。この例のルールは次のように読めます。

```sh
node scripts/explain-profile.mjs examples/profiles/issue-triage.yaml
```

```text
## Rules

The rules are checked in this order; the first one that matches gives the action.

1. If the AI's certainty about "team" is at least 85 %, the action is auto.

If no rule matches, the action is review.
```

`--lang ja` を付けると、同じ内容が日本語で出ます。

```text
1. 「team」についての AI の確信度が 85 % 以上なら、アクションは auto です。
```

公開する前には、プロファイルの検証とテストケースの実行も行います。詳しくは [AI アシスタントとプロファイルを書く](../../authoring.md)を参照してください。
