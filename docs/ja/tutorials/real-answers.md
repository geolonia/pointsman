---
title: 本物の AI で判定する(写真付き)
description: 本物の AI モデルにプロファイルの質問に答えさせ、ケースに写真を付けて送り、回答を見てルールを直します。Cloudflare の無料のアカウントが必要です。
sidebar: { order: 20 }
---

[はじめてのプロファイル](first-profile.md)では、モックの AI モデルが決まった回答を返しました。今回は、自分の Cloudflare のアカウントで本物の AI モデルが答えます。例は駅の忘れ物の受付です。届いた忘れ物をどう扱うかを、Pointsman が判定します。AI が確率を返し、自分で書いたルールがそれをアクションに変える、という Pointsman の考え方を実際に確かめます。20〜30 分ほどかかります。

## 始める前に

- 先に[はじめてのプロファイル](first-profile.md)を終えてください。同じフォルダーを使います。
- Cloudflare のアカウントが必要です。無料のプランで足ります。

<details><summary>費用と、データの送り先</summary>

AI モデルは、自分の Cloudflare のアカウントの Workers AI(Cloudflare の AI サービス)で動きます。Workers AI には毎日の無料枠があり([料金](https://developers.cloudflare.com/workers-ai/platform/pricing/)、英語)、このチュートリアルの呼び出しは 10 回ほどです。送った忘れ物の説明と写真は、プロファイルの質問とその基準と一緒に、自分のアカウントの Workers AI に送られます。それ以外のもの(Pointsman、ルール、トークン、判定ログ)は、すべて自分のコンピューターの中にあります。

</details>

## 1. 本物のモデルで Pointsman を起動する

Cloudflare のコマンドラインツール Wrangler で Cloudflare にサインインし(ブラウザーが開きます)、Pointsman を起動します。

```sh
pnpm exec wrangler login
pnpm dev:live --var AI_GATEWAY_ID:
```

最後のコロンは誤りではありません。空の値を設定します。`Ready on http://localhost:8787` と表示されたら準備完了です。ポート 8787 がほかで使われているときは別のポートが表示されるので、以下のコマンドではそのポートを使ってください。

次の手順は 2 つ目のターミナルで行い、最初のチュートリアルと同じように `POINTSMAN_TOKEN` を設定しておきます。トークンが手元にないときは、別の名前で新しく作ります。

```sh
node scripts/tokens.mjs create --client tutorial-2 --profiles '*' --local
export POINTSMAN_TOKEN=pm_...
```

<details><summary><code>--var AI_GATEWAY_ID:</code> を付ける理由</summary>

`pnpm dev:live` は、ふつうはモデルの呼び出しを `pointsman` という名前の AI Gateway に通し、呼び出しのログを残します。自分のアカウントにはこのゲートウェイがないので、空の値を渡して Workers AI を直接呼び出させます。ゲートウェイの作り方は[モデル](../../models.md)(英語)にあります。

</details>

## 2. プロファイルを読む

プロファイルはリポジトリにすでにあります: [`examples/profiles/lost-and-found.yaml`](../../../examples/profiles/lost-and-found.yaml)。AI に 2 つの質問をします。どんな種類の物か(一覧から 1 つ選ぶ)と、明日までに傷むか(はい・いいえ)です。文章で読みます。

```sh
node scripts/explain-profile.mjs examples/profiles/lost-and-found.yaml
```

ルールの部分は次のとおりです(`--lang ja` を付けると日本語になります)。

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

- `value` は AI の回答、`p` はその回答の確率です。
- `noul` は、はい・いいえで答える質問です。`yes` は「はい」の確率です。

AI は 97.5% の確率で傘だと答え、91% の確率で傷まないと答えたので、忘れ物は棚に置かれます。`rule` は 0 から数えるので、`3` は 4 番目のルールです。モデルが返す数字は毎回同じとは限らないので、少し違うことがあります。

次に、説明を `"A goldfish, found on the ground."`(地面に落ちていた金魚)にして送ってみます。AI は `alive`(生き物、86%)と答え、アクションは `care-now` になります。すぐに誰かが金魚の世話をします。

<details><summary>選択の質問の回答をすべて見る</summary>

回答には、すべての選択肢の確率も入っています。たとえば `"probabilities": { "umbrella": 0.975, "other": 0.0127, … }` です。ルールは、それぞれの確率(`kind.probabilities.alive`)も、いちばん確率の高い選択肢の確率(`kind.p`)も読めます。すべての項目は[プロファイルの形式](../../profile-format.md#policy-conditions)にあります。

</details>

## 4. 写真を付ける

このプロファイルは、リクエストの `item.photos` にある写真を 2 枚まで読みます。写真は文字列として送ります。ファイルの中身を base64 で文字にして、*データ URL* にしたものです。次のコマンドは、リクエストをファイル `request.json` に書いてから送ります。説明には「金魚」と書きますが、写真には別の物が写っています。

```sh
printf '{"state": {"item": {"description": "%s", "photos": ["data:image/jpeg;base64,%s"]}}}' \
  "A goldfish, found on the ground." \
  "$(base64 < examples/tutorials/photos/goldfish-cracker.jpg | tr -d '\n')" > request.json
curl -s localhost:8787/v1/decide/lost-and-found \
  -H "authorization: Bearer $POINTSMAN_TOKEN" \
  -H 'content-type: application/json' \
  -d @request.json
```

```json
{
  "answers": {
    "kind": {
      "type": "choice", "value": "food", "p": 0.4547,
      "probabilities": { "food": 0.4547, "alive": 0.3299, … }
    },
    "perishable": { "type": "noul", "value": true, "p": 0.7641, "yes": 0.7641 }
  },
  "action": "review",
  "rule": null,
  "review": { "status": "pending" }
}
```

写真に写っているのは、金魚の形のクラッカーです。今度は AI に確信がありません。食べ物が 45%、生き物が 33% です。当てはまるルールがないので、最初のチュートリアルと同じように、人が確認します。Pointsman は写真を保存しません。

<details><summary>写真について詳しく</summary>

- 写真の場所はプロファイルに書きます: `images: { path: $.item.photos, max: 2 }`。
- PNG、JPEG、WebP が使えます。1 枚 4 MiB までです。文章のない写真でも判定できますが、プロファイルが読む項目はリクエストに必要です。`"description": ""` を一緒に送ります。ない場合、Pointsman は `400` を返します。
- 判定ログには、写真ごとのハッシュだけを残します。ハッシュは短い指紋のようなもので、ここから写真を元に戻すことはできません。
- ほかに試せる写真が [`examples/tutorials/photos/`](../../../examples/tutorials/photos/) にあります。傘、財布、弁当です。PNG のファイルでは、`data:image/jpeg` の代わりに `data:image/png` と書きます。
- 詳しくは[プロファイルの形式の「画像」](../../profile-format.md#images)にあります。

</details>

## 5. 足りない点を見つける

弁当を送ります。

```sh
printf '{"state": {"item": {"description": "%s", "photos": ["data:image/jpeg;base64,%s"]}}}' \
  "A bento box." \
  "$(base64 < examples/tutorials/photos/bento.jpg | tr -d '\n')" > request.json
curl -s localhost:8787/v1/decide/lost-and-found \
  -H "authorization: Bearer $POINTSMAN_TOKEN" \
  -H 'content-type: application/json' \
  -d @request.json
```

AI は 94% の確率で食べ物だと答え、72% の確率で傷むと答えます。3 番目のルールの 80% に届かないので、アクションは `review` です。弁当は毎回、人が確認することになります。

足りない点はもう 1 つあります。モデルの回答は毎回同じとは限りません。試したときに一度、クラッカーの写真が食べ物 61%、生き物 19% となり、3 番目のルールで捨てる判定になりました。生き物かもしれない物は、人が確認するべきです。

## 6. ルールを直す

`examples/profiles/lost-and-found.yaml` で、`version: 1` を `version: 2` に変えます。次に、`policy` に `# new` の付いた 2 つのルールを加えます。

```yaml
policy:
  rules:
    - when: "kind.probabilities.alive >= 0.5"
      action: care-now
    - when: "kind.probabilities.id-or-money >= 0.5"
      action: police
    - when: "kind.probabilities.alive >= 0.1" # new
      action: review
    - when: "kind.probabilities.food >= 0.8 and perishable.yes >= 0.6" # new
      action: discard
    - when: "perishable.yes >= 0.8"
      action: discard
    - when: "kind.p >= 0.7 and perishable.yes < 0.3"
      action: shelf
  default: review
```

数字は自分で決めるものです。ここでは、生き物の確率が 10% あれば人を呼び、食べ物が傷む確率が 60% あれば捨てることにしました。自分のケースに合わせて決めてください。

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

出力の最後の部分です(前からある 5 つのケースも合格します)。

```text
  PASS  a bento that will spoil is thrown away: discard
         If the probability that "kind" is "food" is at least 80 % and the probability that "perishable" is yes is at least 60 %, the action is discard.
  PASS  something that may be alive goes to a person: review
         If the probability that "kind" is "alive" is at least 10 %, the action is review.
7 passed, 0 failed, 0 could not run, 0 skipped
```

バージョン 2 を読み込ませるため、Pointsman を起動し直します。Pointsman のターミナルで Ctrl+C を押し、もう一度 `pnpm dev:live --var AI_GATEWAY_ID:` を実行します。弁当をもう一度送ると、今度はアクションが `discard` になり、`"profile_version": 2` と表示されます。

## ここまでで行ったこと

本物の AI モデルが、文章と写真からプロファイルの質問に答えました。回答から足りない点が見えたので、ルールを直し、AI にもう一度聞かずにテストで確かめました。次は:

- [オンラインで動かす](put-it-online.md): 次のチュートリアル。自分の Pointsman を Cloudflare にデプロイし、ほかのシステムから使えるようにします。
- [AI アシスタントとプロファイルを書く](../../authoring.md): 自分のプロファイルを下書きします。

最後に、Pointsman を止め(Ctrl+C)、変更を元に戻し、リクエストのファイルを消します。

```sh
git checkout examples/profiles/lost-and-found.yaml examples/cases/lost-and-found.yaml
rm request.json
```
