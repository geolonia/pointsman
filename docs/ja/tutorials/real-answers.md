---
title: 本物の AI で判定する(写真付き)
description: 本物の AI モデルにプロファイルの質問に答えさせ、ケースに写真を付けて送り、回答を見てルールを直します。Cloudflare の無料のアカウントが必要です。
sidebar: { order: 20 }
---

[はじめてのプロファイル](first-profile.md)では、モックの AI モデルが決まった回答を返しました。今回は、自分の Cloudflare のアカウントで本物の AI モデルが答えます。例は駅の忘れ物の受付です。届いた忘れ物をどう扱うかを、Pointsman が判定します。20 分ほどかかります。

## 始める前に

- 先に[はじめてのプロファイル](first-profile.md)を終えてください。同じフォルダーと同じトークンを使います。
- Cloudflare のアカウントが必要です。無料のプランで足ります。

<details><summary>費用について</summary>

AI モデルは、自分の Cloudflare のアカウントの Workers AI で動きます。Workers AI には毎日の無料枠があり([料金](https://developers.cloudflare.com/workers-ai/platform/pricing/)、英語)、このチュートリアルの呼び出しは 10 回ほどです。それ以外のもの(Pointsman、プロファイル、トークン、判定ログ)は、すべて自分のコンピューターの中にあります。

</details>

## 1. 本物のモデルで Pointsman を起動する

Cloudflare にサインインし(ブラウザーが開きます)、Pointsman を起動します。

```sh
pnpm exec wrangler login
pnpm dev:live --var AI_GATEWAY_ID:
```

`Ready on http://localhost:8787` と表示されたら準備完了です。次の手順は 2 つ目のターミナルで行い、最初のチュートリアルと同じように `POINTSMAN_TOKEN` を設定しておきます。

<details><summary><code>--var AI_GATEWAY_ID:</code> を付ける理由</summary>

`pnpm dev:live` は、ふつうはモデルの呼び出しを `pointsman` という名前の AI Gateway に通し、呼び出しのログを残します。自分のアカウントにはこのゲートウェイがないので、空の値を渡して Workers AI を直接呼び出させます。ゲートウェイの作り方は[モデル](../../models.md)(英語)にあります。

ポート 8787 がほかで使われているときは、Wrangler が別のポートを選んで表示します。以下のコマンドでは、そのポートを使ってください。

</details>

## 2. プロファイルを読む

プロファイルはリポジトリにすでにあります: [`examples/profiles/lost-and-found.yaml`](../../../examples/profiles/lost-and-found.yaml)。AI に 2 つの質問をします。どんな種類の物か(一覧から 1 つ選ぶ)と、明日までに傷むか(はい・いいえ)です。ルールを読みます。

```sh
node scripts/explain-profile.mjs examples/profiles/lost-and-found.yaml
```

表示されるルールは次のとおりです(`--lang ja` を付けると日本語になります)。

```text
## Rules

The rules are checked in this order; the first one that matches gives the action.

1. If the probability that "kind" is "alive" is at least 50 %, the action is care-now.
2. If the probability that "kind" is "id-or-money" is at least 50 %, the action is police.
3. If the probability that "perishable" is yes is at least 80 %, the action is discard.
4. If the AI's certainty about "kind" is at least 70 % and the probability that "perishable" is yes is less than 30 %, the action is shelf.

If no rule matches, the action is review.
```

## 3. 文章で判定を依頼する

```sh
curl -s localhost:8787/v1/decide/lost-and-found \
  -H "authorization: Bearer $POINTSMAN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"state": {"item": {"description": "A black folding umbrella.", "found_at": "Platform 2"}}}'
```

レスポンス(一部):

```json
{
  "answers": {
    "kind": { "type": "choice", "value": "umbrella", "p": 0.975 },
    "perishable": { "type": "noul", "value": false, "p": 0.9074, "yes": 0.0926 }
  },
  "action": "shelf",
  "model": "clef-flash",
  "rule": 3
}
```

AI は 97.5 % の確率で傘だと答え、傷まないとも答えたので、忘れ物は棚に置かれます。`rule` は 0 から数えるので、`3` は 4 番目のルールです。数字は少し違うことがあります。

次に、説明を `"A goldfish, found on the ground."`(地面にいた金魚)にして送ってみます。AI は `alive`(生き物、86 %)と答え、アクションは `care-now` になります。すぐに誰かが金魚の世話をします。

<details><summary>選択の質問の回答をすべて見る</summary>

回答には、すべての選択肢の確率も入っています。たとえば `"probabilities": { "umbrella": 0.975, "other": 0.0127, … }` です。ルールは、それぞれの確率(`kind.probabilities.alive`)も、いちばん確率の高い選択肢の確率(`kind.p`)も読めます。すべての項目は[プロファイルの形式](../../profile-format.md#policy-conditions)にあります。

</details>

## 4. 写真を付ける

このプロファイルは、リクエストの `item.photos` にある写真を 2 枚まで読みます。写真は文字列(base64 のデータ URL)として送ります。次のコマンドは、リクエストをファイルに書いてから送ります。説明には「金魚」と書きますが、写真には別の物が写っています。

```sh
printf '{"state": {"item": {"description": "%s", "photos": ["data:image/jpeg;base64,%s"]}}}' \
  "A goldfish, found on the ground." \
  "$(base64 < examples/photos/goldfish-cracker.jpg | tr -d '\n')" > request.json
curl -s localhost:8787/v1/decide/lost-and-found \
  -H "authorization: Bearer $POINTSMAN_TOKEN" \
  -H 'content-type: application/json' \
  -d @request.json
```

```json
{
  "answers": {
    "kind": { "type": "choice", "value": "food", "p": 0.4547 },
    "perishable": { "type": "noul", "value": true, "p": 0.7641, "yes": 0.7641 }
  },
  "action": "review",
  "rule": null,
  "review": { "status": "pending" }
}
```

写真に写っているのは、金魚の形のクラッカーです。今度は AI に確信がありません。食べ物が 45 %、生き物が 33 % です。当てはまるルールがないので、人が確認します。

<details><summary>写真について詳しく</summary>

- 写真の場所はプロファイルに書きます: `images: { path: $.item.photos, max: 2 }`。
- PNG、JPEG、WebP が使えます。1 枚 4 MiB までです。文章のない写真だけでも判定できます。
- Pointsman は写真を保存しません。判定ログにはハッシュだけを残します。
- ほかに試せる写真が [`examples/photos/`](../../../examples/photos/) にあります。傘、財布、弁当です。PNG のファイルでは、`data:image/jpeg` の代わりに `data:image/png` と書きます。
- 詳しくは[プロファイルの形式の「画像」](../../profile-format.md#images)にあります。

</details>

## 5. ルールを直す

`bento.jpg` を、説明 `"A bento box."` と一緒に送ります。AI は 94 % の確率で食べ物だと答え、72 % の確率で傷むと答えます。3 番目のルールの 80 % に届かないので、弁当は毎回、人が確認することになります。また、私たちが試したときには一度、クラッカーの写真が食べ物 61 %、生き物 19 % となり、3 番目のルールで捨てる判定になりました。生き物かもしれない物は、人が確認するべきです。

`examples/profiles/lost-and-found.yaml` で、3 番目のルールの前に 2 つのルールを加え、バージョンを上げます。

```yaml
version: 2
```

```yaml
    - when: "kind.probabilities.alive >= 0.1"
      action: review
    - when: "kind.probabilities.food >= 0.8 and perishable.yes >= 0.6"
      action: discard
```

`examples/cases/lost-and-found.yaml` の最後に 2 つのテストケースを加え、実行します。

```yaml
  - name: a bento that will spoil is thrown away
    expect: discard
    answers: { kind: food, perishable: 0.7 }

  - name: something that may be alive goes to a person
    expect: review
    answers: { kind: { food: 0.5, alive: 0.3, other: 0.2 }, perishable: 0.8 }
```

```sh
node scripts/test-profile.mjs examples/cases/lost-and-found.yaml --profiles examples/profiles
```

```text
examples/cases/lost-and-found.yaml (lost-and-found, v2)
  …
  PASS  a bento that will spoil is thrown away: discard
         If the probability that "kind" is "food" is at least 80 % and the probability that "perishable" is yes is at least 60 %, the action is discard.
  PASS  something that may be alive goes to a person: review
         If the probability that "kind" is "alive" is at least 10 %, the action is review.
7 passed, 0 failed, 0 could not run, 0 skipped
```

Pointsman を起動し直し(Ctrl+C のあと `pnpm dev:live --var AI_GATEWAY_ID:`)、弁当をもう一度送ります。今度はアクションが `discard` になり、`"profile_version": 2` と表示されます。

## ここまでで行ったこと

本物の AI モデルが、文章と写真からプロファイルの質問に答えました。回答から足りない点が見えたので、ルールを直し、AI にもう一度聞かずにテストで確かめました。次は:

- [使い方を選ぶ](../how-to/choose-a-setup.md): Pointsman をオンラインで動かし、ほかのシステムから使えるようにします。
- [AI アシスタントとプロファイルを書く](../../authoring.md): 自分のプロファイルを下書きします。

最後に、変更を元に戻し、リクエストのファイルを消します。

```sh
git checkout examples/profiles/lost-and-found.yaml examples/cases/lost-and-found.yaml
rm request.json
```
