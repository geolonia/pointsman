---
title: Pointsman をデプロイする
description: 非公開の設定用リポジトリから Pointsman を Cloudflare にデプロイし、API トークンを入れ替える方法を説明します。
sidebar: { order: 20 }
translatedFrom: f97b3b6
---

エンジンはオープンソースです。1 つの組織に固有のものは、すべて非公開にしておきます。デプロイの中心は、[`template/config-repo`](../../../template/config-repo/)(英語)から作る**非公開の設定用リポジトリ**です。設定用リポジトリは、エンジンのコミットを 1 つに固定し、プロファイルとデプロイの設定を持ちます。

| 何を | どこに | 公開範囲 |
|---|---|---|
| エンジン(Worker、アダプター、ポリシー)、プロファイルのスキーマ、検証ツール、スクリプト、ドキュメント、例のプロファイル | エンジンのリポジトリ | 公開 |
| 実際のプロファイル、wrangler の設定(リソースの ID、Worker の名前、ルート)、AI Gateway の設定 | 自分の設定用リポジトリ | 非公開 |
| デプロイされたプロファイル、API トークン(ハッシュ) | KV の名前空間 `PROFILES`、`TOKENS` | 自分の Cloudflare アカウント |
| 判定ログとフィードバック | D1 データベース | 自分の Cloudflare アカウント。Git には決して入れない |
| Cloudflare の API トークンとアカウント ID | 設定用リポジトリの GitHub Actions のシークレット | 非公開 |

公開しているエンジンのリポジトリには、アカウント ID、リソースの ID、実際のプロファイルを入れてはいけません。CI で `scripts/check-public.mjs` がそれを確かめます。

## 準備する {#set-up}

1. **Cloudflare のリソースを作ります**(1 回だけ)。`wrangler login` でログインしてから実行します。

   ```sh
   npx wrangler kv namespace create PROFILES
   npx wrangler kv namespace create TOKENS
   npx wrangler d1 create pointsman
   ```

   AI Gateway は [models.md](../../models.md)(英語)のとおりに作ります。AI Gateway を使わず Workers AI を直接呼び出す場合は、設定から `AI_GATEWAY_ID` を削除します。

2. テンプレートから**非公開のリポジトリを作ります**。`template/config-repo/` の中身を、`.github/` と `.gitignore` も含めて、そのリポジトリにコピーします。

3. `wrangler.jsonc` の**プレースホルダーを埋めます**(手順 1 の ID と Worker の名前)。`engine.json` では、エンジンをエンジンのリポジトリのコミット SHA に固定します。プロファイルが使う[ファクトモジュール](../../modules.md)(英語)を `modules.facts` に並べます(使わない場合は `[]`)。ビルドには、並べたモジュールだけが入ります。`modules` がない場合は、すべてのモジュールが選ばれます。`<placeholder>` が 1 つでも残っているとき、または不明なモジュールがあるときは、ワークフローは実行を拒みます(`engine/scripts/check-config.mjs`)。

4. `profiles/` に**プロファイルを追加します**(`<id>.yaml`。[profile-format.md](../../profile-format.md) を参照)。

5. リポジトリに**シークレットを追加します**。置き場所は `production` という名前の環境です。
   - `CLOUDFLARE_API_TOKEN`: そのアカウントで *Workers Scripts: Edit*、*Workers KV Storage: Edit*、*D1: Edit* の権限を持つ API トークン
   - `CLOUDFLARE_ACCOUNT_ID`

6. **`main` に push します。** デプロイのワークフローが、データベースのマイグレーションを適用し、エンジンをデプロイし、プロファイルを公開します。

7. 最初のデプロイのあとで、**コールバックのシークレットを設定します**(1 回だけ。クライアントが `callback_url` を使う場合にだけ必要です。[reviews.md](../../reviews.md)(英語)を参照)。

   ```sh
   openssl rand -hex 32 | npx wrangler secret put CALLBACK_SECRET --config wrangler.jsonc
   ```

   コールバックを受け取るクライアントにも、同じ値を渡します。

   ファクトのためのシークレットも、同じ方法で設定します。たとえば [GitHub のファクト](../../profile-format.md#github-pull-requests)のためのトークンです。先にシークレットを設定し、そのあとでファクトを有効にします。`FACTS_GITHUB: "token"` を設定したのに `FACTS_GITHUB_TOKEN` がないと、エンジンはすべてのリクエストを拒否します(設定のエラーとして扱います)。

   1. `FACTS_GITHUB` を設定しないか `"off"` にして、1 回デプロイします。
   2. シークレットを設定します。

      ```sh
      npx wrangler secret put FACTS_GITHUB_TOKEN --config wrangler.jsonc
      ```

   3. `wrangler.jsonc` で `FACTS_GITHUB: "token"` を設定し、`main` に push します。

8. クライアントのために **API トークンを作ります**。

   ```sh
   git clone https://github.com/geolonia/pointsman engine   # once, at the pinned commit
   git -C engine checkout "$(jq -r .ref engine.json)" && pnpm --dir engine install
   node engine/scripts/tokens.mjs create --client my-client --profiles issue-triage --remote --config wrangler.jsonc
   ```

## ワークフローがすること {#what-the-workflows-do}

- **Validate**(プルリクエストと `main`。シークレットは使いません): 設定を確かめ、固定したエンジンでプロファイルを検証し(そのため、スキーマのバージョンも固定されます)、デプロイを試しに実行します(dry run)。
- **Deploy**(`main`): 同じ確認とビルドをして試しに実行し、そのあとで初めて `wrangler d1 migrations apply`、`wrangler deploy`、`publish-profiles.mjs` を実行します。Cloudflare のシークレットを渡すのは、この 3 つのステップだけです。エンジンは、プロファイルを公開する前にデプロイします。新しいエンジンは古いプロファイルを読めますが、動いている古いエンジンは新しいプロファイル(たとえばファクトを使うもの)を理解できないことがあり、その間の判定が失敗するためです。

## プロファイルのバージョン {#profile-versions}

`publish-profiles.mjs` は、`profile:<id>:<version>` のキーと `index` を書き込みます。公開したバージョンは変わりません。どのバージョンも、まず内容のハッシュとともに D1 のテーブル `profile_versions` に登録されます。このテーブルは、KV と違って強い整合性を持ちます。登録済みのバージョンの内容が違っていれば、デプロイは止まり、何も書き込まれません。変更のたびに `version` を上げてください。検証のワークフローがプルリクエストでこれを確かめるため(`scripts/check-profile-versions.mjs`)、バージョンの上げ忘れはマージの前に見つかります。古いバージョンは KV に残ります。そのため、古い判定へのフィードバックは、その判定を出したバージョンと照らし合わせて確かめられます。リポジトリからプロファイルを削除すると、そのプロファイルは `index` から外れて呼び出せなくなりますが、そのバージョンは残ります。

## エンジンを更新する {#updating-the-engine}

`engine.json` の `ref` を新しいコミットに変えて、プルリクエストを作ります。何かをデプロイする前に、validate のワークフローが、そのバージョンのエンジンでプロファイルと `modules` のファクトモジュールを確かめます。

エンジンのリポジトリそのものは、`engine.json` から読むのではなく、ワークフローの中で固定しています(`ENGINE_REPOSITORY`)。ワークフローはエンジンのコードを実行し、デプロイのワークフローは Cloudflare の認証情報も使います。そのため、`engine.json` だけを変えるプルリクエストで、ワークフローに別のコードを実行させることはできません。

新しいエンジンは、データベースのマイグレーションを追加することがあります(エンジンのリポジトリの `migrations/`。チェックアウトでは `engine/migrations/` です。たとえば 0.8.0 では、判定ログからのファクトのために `0008_log_facts.sql` が加わりました)。デプロイのワークフローは、エンジンをデプロイする前にマイグレーションを適用します。そのため、更新のための手順は要りません。ワークフローを使わずにデプロイするときは、マイグレーションを先に適用します。設定用リポジトリで、エンジンをチェックアウトしてインストールし(手順 8 と同じ)、Cloudflare のアカウントに接続できる状態で、次のコマンドを実行します。

```sh
engine/node_modules/.bin/wrangler d1 migrations apply DB --remote --config wrangler.jsonc
```

## GitHub のコネクターをつなぐ {#connect-the-github-connector}

[GitHub のコネクター](../../github-connector.md)は、エンジンとは別の Worker です。エンジンと同じ Cloudflare アカウントにあれば、内部呼び出しを使えます。この場合、トークンは要りません。それ以外の場合は、API トークンが要ります([準備する](#set-up)の手順 8)。設定と、コネクターをトークンから内部呼び出しに切り替える手順は、[Pointsman へのつなぎ方](../../github-connector.md#how-it-reaches-pointsman)にあります。

## API トークンを入れ替える {#rotate-an-api-token}

API で Pointsman を呼び出すクライアントは、それぞれ自分の API トークンを持っています(GitHub のコネクターの内部呼び出しはトークンを使わないため、入れ替えるものはありません)。トークンの期限が近いとき、トークンを知っていた人が抜けたとき、漏れたおそれがあるときは、トークンを入れ替えます。ここで説明する手順なら、サービスを止めることなく入れ替えられます。古いトークンは、先に期限が切れない限り、手順 3 で取り消すまで使えます。`--keep-old` は期限を延ばしません。始める前に `list` で古いトークンの期限を確かめ、その時刻より前に終えてください。

コマンドは Pointsman のエンジンのチェックアウトで実行します。デプロイ先の Cloudflare アカウントへのアクセスも必要です。テンプレートから作った設定用リポジトリではエンジンが `engine/` にあるため、代わりに `node engine/scripts/tokens.mjs` を実行します。例では `--local`(手元のコンピューターで動かす開発用の Worker)を使います。デプロイ済みの Worker では `--remote --config <your wrangler config>` を使います(`<your wrangler config>` は wrangler の設定ファイル)。

### 1. 新しいトークンを作る {#1-make-the-new-token}

```sh
node scripts/tokens.mjs rotate --client github-triage --expires 90d --keep-old --local
```

```text
client:  github-triage
profiles: issue-triage
hash:    53d466bb…
expires: 2027-01-20T15:44:39.807Z

token (shown once, store it as a secret):
pm_…

old token kept; revoke it once the new one is in place:
  node scripts/tokens.mjs revoke --hash 3138a1cc… --local
```

新しいトークンで使えるプロファイルは、古いトークンと同じです。トークンが表示されるのはこの 1 回だけなので、すぐに控えてください。Pointsman はトークンのハッシュだけを保存します(上の出力では、ハッシュとトークンを短くしています)。

`--expires` には、今からの期間(`12h`、`90d`、`2w`)か日付(`2027-01-31`。その日の終わり、UTC)を、1 時間以上先になるように指定します。古いトークンに期限があった場合は、新しいトークンにも `--expires` か `--no-expiry` が必要です。うっかり期限のないトークンができるのを防ぐためです。

### 2. クライアントに新しいトークンを渡す {#2-give-the-client-the-new-token}

新しいトークンをクライアントのシークレットの保存先(GitHub Actions のシークレットなど)に入れ、クライアントが動くことを確かめます。手順 3 が終わるまで、`list` では、新しいトークンと古いトークンのすべてに同じクライアント名が表示されます。古いトークンが 1 つなら 2 つ、複数あればそれ以上です。これは想定どおりです。

```sh
node scripts/tokens.mjs list --local
```

### 3. 古いトークンを取り消す {#3-revoke-the-old-token}

手順 1 で表示されたコマンドを、そのまま実行します。このコマンドには、手順 1 と同じ `--local` または `--remote` と `--config` が付いています。デプロイ済みの Worker では、2 行目のようになります。

```sh
node scripts/tokens.mjs revoke --hash <old hash> --local
node scripts/tokens.mjs revoke --hash <old hash> --remote --config=<your wrangler config>
```

```text
revoked 3138a1cc…
```

古いトークンがすべての場所で使えなくなるまで、最大で 60 秒ほどかかります。

### うまくいかないとき {#if-something-goes-wrong}

- **新しいトークンでクライアントが失敗する:** 手順 3 までは古いトークンが使えます。シークレットの名前と値を確かめてから、やり直してください。
- **手順 2 の前に新しいトークンをなくした:** 手順 1 で表示されたハッシュで新しいトークンを取り消し、最初からやり直します。
- **トークンが漏れたおそれがある:** `--keep-old` を付けずに実行します。古いトークンはすぐに取り消され(すべての場所で使えなくなるまで最大で 60 秒ほどかかります)、クライアントは新しいトークンを受け取るまで失敗します。

トークンのスクリプトのすべてのオプションは、README の [API tokens](../../../README.md#api-tokens)(英語)にあります。
