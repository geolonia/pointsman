---
title: オンラインで動かす
description: 非公開の GitHub リポジトリから自分の Pointsman を Cloudflare にデプロイし、インターネット越しに呼び出し、プルリクエストでプロファイルを変えます。
sidebar: { order: 30 }
---

これまで Pointsman は自分のコンピューターで動いていました。今回はオンラインで動かし、ほかのシステムがインターネット越しに呼び出せるようにします。プロファイルは、非公開の GitHub リポジトリ(*設定リポジトリ*)に置きます。このリポジトリにプッシュするたびに、Pointsman が自分の Cloudflare のアカウントにデプロイされます。45 分ほどかかります。

## 始める前に

- 先に[本物の AI で判定する(写真付き)](real-answers.md)を終えてください。そこで Wrangler から Cloudflare にサインインしています。
- GitHub のアカウントと、`gh auth login` でサインインした [GitHub CLI](https://cli.github.com/)(`gh`、英語)が必要です。デプロイはシークレットを GitHub の*環境*(environment)に保存します。非公開のリポジトリでこれを使うには、GitHub Pro、Team、Enterprise のいずれかが必要です。

<details><summary>作るものと費用</summary>

- プロファイルを置く、非公開の GitHub リポジトリ。
- 自分の Cloudflare のアカウントに、Worker(Pointsman 本体)、KV の名前空間 2 つ(プロファイルとトークンの保存先)、D1 のデータベース 1 つ(判定ログ)。
- このような試しであれば、どれも Cloudflare の無料のプランに収まります。AI の呼び出しには、前のチュートリアルと同じく Workers AI を使います。

最後にすべて消せます。[片付け](#clean-up)を見てください。

</details>

## 1. 設定リポジトリを作る

前のチュートリアルの最後と同じく、`pointsman` フォルダーの中から始めます。最初のコマンドで 1 つ上のフォルダーに移り、新しいフォルダー `my-pointsman` を `pointsman` の隣に作ります。テンプレートをコピーし、忘れ物のプロファイルとテストケースを入れます。

```sh
cd ..
mkdir my-pointsman
cp -R pointsman/template/config-repo/. my-pointsman/
cd my-pointsman
rm profiles/issue-triage.yaml
cp ../pointsman/examples/profiles/lost-and-found.yaml profiles/
mkdir cases
cp ../pointsman/examples/cases/lost-and-found.yaml cases/
```

プロファイルはバージョン 1 でなければなりません。前のチュートリアルの最後で元に戻していないときは、`git -C ../pointsman checkout examples` を実行し、2 つのファイルをもう一度コピーします。

デプロイはいつも決まったバージョンのエンジンを使い、自分のコンピューターのスクリプトも同じバージョンを使うべきです。そのため、設定リポジトリはフォルダー `engine/` にエンジンの写しを持ちます(Git はこのフォルダーを無視します)。最新のリリースを取ってきます(ダウンロードに 1 分ほどかかります)。

```sh
git clone https://github.com/geolonia/pointsman engine
git -C engine checkout "$(gh release view --repo geolonia/pointsman --json tagName --jq .tagName)"
pnpm --dir engine install --frozen-lockfile
```

## 2. Cloudflare に保存先を作る

`wrangler.jsonc` をエディターで開きます。コメントを含められる JSON(*JSONC*)のファイルです。`"name"` の行を次の行に置き換えて、Worker に名前を付けます。名前は Worker のウェブのアドレスの一部になるので、小文字の英字とダッシュを使います。

```jsonc
  "name": "my-pointsman",
```

次に、KV の名前空間 2 つと D1 のデータベースを作ります。

```sh
engine/node_modules/.bin/wrangler kv namespace create PROFILES
engine/node_modules/.bin/wrangler kv namespace create TOKENS
engine/node_modules/.bin/wrangler d1 create my-pointsman
```

それぞれのコマンドが ID を表示します(D1 のコマンドでは `database_id` という名前です)。たとえば次のとおりです。

```text
    {
      "binding": "PROFILES",
      "id": "<32 characters: 0-9 and a-f>"
    }
? Would you like Wrangler to add it on your behalf?
```

**No** と答えます。テンプレートにはすでに項目があるので、次の手順で ID を書き入れるだけです。それまで 3 つの ID を控えておきます。

## 3. 設定を書き入れる

`wrangler.jsonc` の `<placeholder>` を、それぞれ自分の値に置き換えます。

- `<PROFILES namespace id>` と `<TOKENS namespace id>`: 2 つの KV の ID。
- `<D1 database name, e.g. pointsman>`: `my-pointsman`。
- `<D1 database id>`: D1 の ID。

また、`"AI_GATEWAY_ID": "pointsman"` の行とその上のコメントを消します。前のチュートリアルと同じく、Pointsman が Workers AI を直接呼び出すようになります。その前の行が一覧の最後になるので、その行のコンマも消します。`vars` の最初の部分は次のようになります。

```jsonc
  "vars": {
    "PROFILE_SOURCE": "kv",
    "MODEL_MODE": "workers-ai"
```

ファイルを壊してしまっても、次の確認で行が示されます。

そのリリースのコミットで `engine.json` を書きます。

```sh
cat > engine.json <<EOF
{
  "repository": "geolonia/pointsman",
  "ref": "$(git -C engine rev-parse HEAD)",
  "modules": { "facts": [] }
}
EOF
```

`ref` は、変えるまでどのデプロイでも使うエンジンのコミットです。忘れ物のプロファイルはデータからファクトを読まないので、`facts` は空にします。設定とプロファイルを確かめます。

```sh
node engine/scripts/check-config.mjs
node engine/scripts/validate-profiles.mjs profiles
```

```text
Config ready.
ok    profiles/lost-and-found.yaml

1 valid, 0 invalid
```

<details><summary>ファクト、AI Gateway、新しいエンジン</summary>

- ファクト(たとえば浸水想定区域)を読むプロファイルには、そのモジュールを `modules.facts` に書きます。[ファクトモジュール](../../modules.md)(英語)を見てください。
- AI Gateway は、モデルの呼び出しのログを残します。[モデル](../../models.md)(英語)を見てください。
- あとで新しいエンジンを使うときは、その[リリース](https://github.com/geolonia/pointsman/releases)を `engine/` でチェックアウトし(`git -C engine fetch --tags` のあと `git -C engine checkout <tag>`)、上と同じように新しいコミットを `ref` に書きます。

</details>

## 4. GitHub のリポジトリを作る

```sh
git init -b main
git add .
git commit -m "My Pointsman"
gh repo create my-pointsman --private --source . --remote origin
gh api -X PUT 'repos/{owner}/{repo}/environments/production'
```

最後のコマンドは、環境 `production` を作ります。デプロイはここからシークレットを読みます。まだプッシュしません。デプロイには、先に 2 つのシークレットが必要です。

**デプロイ用の Cloudflare の API トークン。** GitHub はこれを*シークレット*として保存します。デプロイは使えますが、誰も読み出せません。Cloudflare のダッシュボードで [Account API tokens](https://dash.cloudflare.com/?to=/:account/api-tokens) を開き、**Create Token** を選び、**Custom token** の横の **Get started** を選びます。自分のアカウントを選び、次の権限を加えます。

- **Workers Admin**: 最初のデプロイが Worker を作ります。
- **Workers KV Storage Write**: デプロイがプロファイルを公開します。
- **D1 Write**: デプロイが判定ログを準備します。

トークンをシークレットに保存します。コマンドがトークンの貼り付けを求めます。貼り付けても何も表示されないので、Enter を 1 回押します。

```sh
gh secret set CLOUDFLARE_API_TOKEN --env production
```

**アカウント ID。** `engine/node_modules/.bin/wrangler whoami` の「Account ID」の列に表示されます。同じように保存します。

```sh
gh secret set CLOUDFLARE_ACCOUNT_ID --env production
```

## 5. デプロイする

```sh
git push -u origin main
gh run watch
```

実行が 2 つ同時に始まるので、`gh run watch` はどれを見るかを尋ねます。**Deploy** を選びます。設定とプロファイルを確かめ、データベースを準備し、Pointsman をデプロイし、プロファイルを公開します。数分かかります。`.github/workflows` のためにプッシュが拒否されたときは、`gh auth refresh -s workflow` を実行してからもう一度プッシュします。

アドレスは、同じ実行のログで確かめます(`gh run view --log`、もう一度 **Deploy** を選ぶ)。デプロイの最後の部分は次のとおりです(名前は自分のものになります)。

```text
Uploaded my-pointsman (2.04 sec)
Deployed my-pointsman triggers (0.79 sec)
  https://my-pointsman.<your-subdomain>.workers.dev
  schedule: */5 * * * *
New: lost-and-found@1
Index: lost-and-found@1
Published.
```

`workers.dev` で終わる行が、自分の Pointsman のアドレスです。

<details><summary>デプロイが失敗したとき</summary>

`gh run view --log-failed` でエラーを表示できます。

- アップロードが始まった直後の **「No access to the specified resource」**: トークンが Worker を作れません。トークンに **Workers Admin** を付けて保存し直し、`gh run rerun --failed` を実行します。
- 「Uploaded」の直後の **「This Worker does not exist on your account」(code 10007)**: 最初のデプロイでは、Cloudflare の準備が間に合わないことがあります。`gh run rerun --failed` を実行します。
- **「Config not ready」**: `<placeholder>` が残っているか、モジュールの名前が誤っています。メッセージにその名前が出ます。
- **workers.dev のサブドメインについてのエラー**: アカウントにまだサブドメインがありません。Cloudflare のダッシュボードで一度 **Workers & Pages** を開いてサブドメインを選び、`gh run rerun --failed` を実行します。

</details>

## 6. インターネット越しに呼び出す

デプロイした Pointsman に、忘れ物のプロファイルだけに使える API トークンを作ります。コマンドはトークンを一度だけ表示します。それを `POINTSMAN_TOKEN` に、手順 5 のアドレスを `POINTSMAN_URL` に設定します。

```sh
node engine/scripts/tokens.mjs create --client tutorial --profiles lost-and-found --remote --config wrangler.jsonc
export POINTSMAN_TOKEN=pm_...
export POINTSMAN_URL=https://my-pointsman.<your-subdomain>.workers.dev
```

前のチュートリアルと同じ金魚の写真を、今度はインターネット越しに送ります。

```sh
printf '{"state": {"item": {"description": "%s", "photos": ["data:image/jpeg;base64,%s"]}}}' \
  "A goldfish, found on the ground." \
  "$(base64 < ../pointsman/examples/tutorials/photos/goldfish-cracker.jpg | tr -d '\n')" > request.json
curl -s "$POINTSMAN_URL/v1/decide/lost-and-found" \
  -H "authorization: Bearer $POINTSMAN_TOKEN" \
  -H 'content-type: application/json' \
  -d @request.json
```

回答は自分のコンピューターのときと同じで、`"action": "review"`、食べ物 45%、生き物 33% です。アドレスとトークンがあれば、誰でも自分の Pointsman に判定を依頼できるようになりました。有効なトークンのないリクエストには `401` が返ります。

## 7. プルリクエストでプロファイルを変える

プロファイルの変更は、誰かが先に確かめられるよう、プルリクエストで行います。新しいブランチで、プロファイルのバージョン 2 を作ります。

```sh
git switch -c bento-rule
```

`profiles/lost-and-found.yaml` に、[前のチュートリアル](real-answers.md)の手順 6 と同じ変更をします。`version: 2` と、2 つの新しいルールの入った `policy` の部分です。`cases/lost-and-found.yaml` にも、2 つの新しいテストケースを加えます。そのあと次を実行します。

```sh
git commit -am "lost-and-found v2: a person checks what may be alive; throw away food that spoils"
git push -u origin bento-rule
gh pr create --fill
```

プルリクエストでは、チェック(check run)**Validate profiles and config** がテストケースを実行し、バージョンが上がったかを確かめます。合格するまで待ち、マージします。

```sh
gh pr checks --watch
gh pr merge --squash --delete-branch
gh run watch
```

デプロイが新しいバージョンを公開します(`New: lost-and-found@2`)。弁当の写真を送ります。

```sh
printf '{"state": {"item": {"description": "%s", "photos": ["data:image/jpeg;base64,%s"]}}}' \
  "A bento box." \
  "$(base64 < ../pointsman/examples/tutorials/photos/bento.jpg | tr -d '\n')" > request.json
curl -s "$POINTSMAN_URL/v1/decide/lost-and-found" \
  -H "authorization: Bearer $POINTSMAN_TOKEN" \
  -H 'content-type: application/json' \
  -d @request.json
```

今度はアクションが `discard` になり、`"profile_version": 2` と表示されます。

<details><summary>プロファイルをどこに置くか</summary>

| 状況 | プロファイルを置く場所 |
|---|---|
| 1 つのチームが 1 つの Pointsman を使う | このチュートリアルのように、専用の設定リポジトリ。 |
| 1 つの組織で、複数のチームやアプリが使う | 組織の Pointsman のための、共有の設定リポジトリ 1 つ。アプリごとに、そのアプリのプロファイルだけに使えるトークンを渡します。 |
| アプリケーション自身のリポジトリの中 | まだ対応していません。テンプレートは専用のリポジトリを前提にしています。 |

すべての変更にプルリクエストと合格したチェックを求めるよう、`main` を保護してください。設定リポジトリの `README.md`(英語)にあります。

</details>

## ここまでで行ったこと

非公開の設定リポジトリから Pointsman をオンラインで動かし、専用のトークンでインターネット越しに呼び出し、公開の前に確かめられるプルリクエストでプロファイルを変えました。次は:

- [Pointsman をデプロイする](../../deployment.md): すべての設定、有効期限付きのトークン、トークンの入れ替え方。
- [使い方を選ぶ](../how-to/choose-a-setup.md): FIWARE のプラットフォームとつなぐ。
- [AI アシスタントとプロファイルを書く](../../authoring.md): 自分の設定リポジトリで、自分のプロファイルを書く。

## 片付け {#clean-up}

このチュートリアルで作ったものをすべて消すには、`my-pointsman` で次のコマンドを実行します。どのコマンドも確認を求めます。KV の ID は `wrangler.jsonc` にあります。

```sh
engine/node_modules/.bin/wrangler delete --config wrangler.jsonc
engine/node_modules/.bin/wrangler kv namespace delete --namespace-id <PROFILES id>
engine/node_modules/.bin/wrangler kv namespace delete --namespace-id <TOKENS id>
engine/node_modules/.bin/wrangler d1 delete my-pointsman
gh auth refresh -s delete_repo
gh repo delete
```

`gh` がリポジトリを消せるのは、`gh auth refresh -s delete_repo` のあとです。リポジトリを消すと、そのシークレットも消えます。最後に、Cloudflare のダッシュボードで API トークンを消します。
