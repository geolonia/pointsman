---
title: はじめてのプロファイル
description: 自分のコンピューターで Pointsman を動かし、プロファイルを書き、例で確かめ、最初の判定をさせます。クラウドのアカウントは要りません。
sidebar: { order: 10 }
---

このチュートリアルでは、自分のコンピューターで Pointsman を動かし、報告を判定する小さなプロファイルを書いて例で確かめ、判定させます。AI モデルにはモック(決まった答えを返す代わりの実装)を使うため、クラウドのアカウントも AI のサービスも要りません。15 分ほどかかります。

プロファイル、ルール、アクションとは何かは、[判定のしくみ](../explanation/decision-model.md)で説明しています。先に読まなくてもかまいません。

## 始める前に

Node.js 24、pnpm 12、Git が必要です。コードを取得します。

```sh
git clone https://github.com/geolonia/pointsman.git
cd pointsman
pnpm install
```

## 1. Pointsman を起動する

手元の判定ログを作り、Pointsman を起動します。

```sh
pnpm db:migrate:local
pnpm dev
```

次のように表示されたら準備完了です。

```text
[wrangler:info] Ready on http://localhost:8787
```

起動したままにして、以降の手順は別のターミナルで、同じ `pointsman` フォルダーの中で進めます。手元の Pointsman は `examples/profiles/` にある例のプロファイルを使い、モックのモデルは「はい・いいえ」の質問すべてに「いいえ」と 80% の確かさで答えます。

## 2. トークンを作る

どのリクエストにも API トークンが必要です。このチュートリアル用に、すべてのプロファイル(`'*'`)を使えるトークンを手元の保存先に作ります。

```sh
node scripts/tokens.mjs create --client tutorial --profiles '*' --local
export POINTSMAN_TOKEN=pm_...
```

トークン(`pm_` に続く 43 文字)は 1 回だけ表示されます。2 行目のように `POINTSMAN_TOKEN` に入れておきます。もう一度実行すると、`tutorial` という名前にはすでにトークンがあるため断られます。その場合は別の名前を使ってください。

## 3. プロファイルを書く

次の内容を `examples/profiles/report-check.yaml` として保存します。報告について 1 つ質問し、ルールは 1 つです。誰かが危険な状態にあると AI が 70% 以上確信したとき、アクションは `urgent`(至急)になります。それ以外は、人が報告を確認します(`review`)。

- `input` は、リクエストのどの部分を AI に見せるかを選びます。`$.report.text` は、リクエストの中の位置を指すパス(JSONPath)です。
- `noul` は「はい・いいえ」で答える質問で、`criteria` に「はい」と「いいえ」の意味を書きます。
- ルールの `danger.yes` は、AI が「はい」と答える確率です。
- `model` は、実際のデプロイで使う AI モデルの名前です。ここではモックが代わりに答えます。

すべてのフィールドは[プロファイルの形式](../../profile-format.md)で説明しています。

```yaml
id: report-check
version: 1
title:
  en: Report check
  ja: 報告の確認
description:
  en: Send a report about danger to the urgent queue, and every other report to a person.
  ja: 危険についての報告を至急の対応に回し、それ以外の報告は人が確認する。
model: clef-flash
input:
  - { name: text, path: $.report.text }
questions:
  - name: danger
    type: noul
    instructions: Does the report say that someone may be in danger now?
    criteria:
      true: Someone may be hurt or in danger now.
      false: Nobody is in danger now.
policy:
  rules:
    - when: "danger.yes >= 0.7"
      action: urgent
  default: review
```

## 4. 確かめる

検証し、プロファイルを承認する人と同じように、文章で読みます。

```sh
node scripts/validate-profiles.mjs examples/profiles
node scripts/explain-profile.mjs examples/profiles/report-check.yaml
```

1 つ目のコマンドは、プロファイルごとに `ok` と表示します。2 つ目はプロファイル全体を文章で表示します。ルールの部分は次のとおりです(`--lang ja` を付けると日本語になります)。

```text
## Rules

The rules are checked in this order; the first one that matches gives the action.

1. If the probability that "danger" is yes is at least 70 %, the action is urgent.

If no rule matches, the action is review.
```

## 5. 例で試す

テストケースには、どの回答のときにどのアクションになるはずかを書きます。意図と違うルールを、使い始める前に見つけられます。次の内容を `examples/cases/report-check.yaml` として保存し、実行します。

```yaml
profile: report-check
cases:
  - name: a sure danger is urgent
    expect: urgent
    answers: { danger: 0.9 }

  - name: an unsure report goes to a person
    expect: review
    answers: { danger: 0.5 }
```

```sh
node scripts/test-profile.mjs examples/cases/report-check.yaml --profiles examples/profiles
```

```text
examples/cases/report-check.yaml (report-check, v1)
  PASS  a sure danger is urgent: urgent
         If the probability that "danger" is yes is at least 70 %, the action is urgent.
  PASS  an unsure report goes to a person: review
         If no rule matches, the action is review.
2 passed, 0 failed, 0 could not run, 0 skipped
```

## 6. Pointsman に判定させる

Pointsman を止め(Ctrl+C)、`pnpm dev` で起動し直して新しいプロファイルを読み込ませます。それから報告を送ります。

```sh
curl -s localhost:8787/v1/decide/report-check \
  -H "authorization: Bearer $POINTSMAN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"state": {"report": {"text": "A tree fell on the road near the school."}}}'
```

答えは次のとおりです(一部を省略しています)。

```json
{
  "decision_id": "f91cb02c-8f0a-4c47-8011-ba742e148cbc",
  "answers": {
    "danger": { "type": "noul", "value": false, "p": 0.8, "yes": 0.2 }
  },
  "action": "review",
  "profile": "report-check",
  "profile_version": 1,
  "model": "mock",
  "rule": null,
  "review": { "status": "pending" }
}
```

モックのモデルは「危険はない」(`yes: 0.2`)と答えたため、どのルールにも当てはまらず、既定のアクション `review` になりました。判定は人の確認を待っています。

## 7. 人として確認する

確認待ちの判定を一覧し、この判定を決めます。ここでは、確認した人が「やはり至急」と判断し、AI の回答を訂正します。2 つ目のコマンドには、手順 6 の `decision_id` を入れます。

```sh
curl -s 'localhost:8787/v1/reviews?profile=report-check' \
  -H "authorization: Bearer $POINTSMAN_TOKEN"
curl -s -X POST localhost:8787/v1/reviews/<decision_id>/resolve \
  -H "authorization: Bearer $POINTSMAN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"action": "urgent", "correct": {"danger": true}, "by": "you@example.com"}'
```

2 つ目のコマンドの答えは次のとおりです(一部を省略しています)。

```json
{
  "decision_id": "f91cb02c-8f0a-4c47-8011-ba742e148cbc",
  "action": "urgent",
  "answers": { "danger": { "value": true, "source": "human" } },
  "resolved_by": "you@example.com",
  "callback": "none"
}
```

訂正はフィードバックとして残るため、あとからプロファイルがどのくらい正しかったかを測れます。

## ここまでで行ったこと

プロファイルを書き、文章で読み、例で試し、判定させ、人として確認しました。続きは次のページで学べます。

- [プロファイルの形式](../../profile-format.md): ファクトやチェーンを含む、すべてのフィールド。
- [AI アシスタントとプロファイルを書く](../../authoring.md): 同じ手順を、アシスタントに下書きを任せて進める方法。
- [Pointsman をデプロイする](../../deployment.md): 実際のモデルを使い、本番として動かす方法。

片付けるときは、`examples/profiles/report-check.yaml` と `examples/cases/report-check.yaml` を削除します。
