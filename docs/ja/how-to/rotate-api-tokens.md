---
title: API トークンを入れ替える
description: クライアントの API トークンを新しいものに入れ替えます。クライアントが Pointsman に接続できない時間は生じません。
sidebar: { order: 50 }
---

Pointsman を呼び出すクライアントは、それぞれ自分の API トークンを持っています。トークンの期限が近いとき、トークンを知っていた人が抜けたとき、漏れたおそれがあるときは、トークンを入れ替えます。ここで説明する手順では、手順 3 で取り消すまで古いトークンも使えるため、止まる時間がありません。

コマンドは Pointsman のエンジンのチェックアウトで実行します。デプロイ先の Cloudflare アカウントへのアクセスも必要です。テンプレートから作った設定用リポジトリではエンジンが `engine/` にあるため、代わりに `node engine/scripts/tokens.mjs` を実行します。例では `--local`(手元のコンピューターで動かす開発用の Worker)を使います。デプロイ済みの Worker では `--remote --config <wrangler の設定ファイル>` を使います。

## 1. 新しいトークンを作る

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

新しいトークンで使えるプロファイルは、古いトークンと同じです。トークンが表示されるのはこの 1 回だけなので、すぐに控えてください。Pointsman はトークンのハッシュだけを保存します。

`--expires` には、今からの期間(`12h`、`90d`、`2w`)か日付(`2027-01-31`。その日の終わり、UTC)を指定します。古いトークンに期限があった場合は、新しいトークンにも `--expires` か `--no-expiry` が必要です。うっかり期限のないトークンができるのを防ぐためです。

## 2. クライアントに新しいトークンを渡す

新しいトークンをクライアントのシークレットの保存先(GitHub Actions のシークレットなど)に入れ、クライアントが動くことを確かめます。手順 3 が終わるまで、`list` では同じクライアント名のトークンが 2 つ表示されます。これは想定どおりです。

```sh
node scripts/tokens.mjs list --local
```

## 3. 古いトークンを取り消す

手順 1 で表示されたコマンドを実行します。

```sh
node scripts/tokens.mjs revoke --hash <old hash> --local
```

```text
revoked 3138a1cc…
```

古いトークンがすべての場所で使えなくなるまで、最大で 60 秒ほどかかります。

## うまくいかないとき

- **新しいトークンでクライアントが失敗する:** 手順 3 までは古いトークンが使えます。シークレットの名前と値を確かめてから、やり直してください。
- **手順 2 の前に新しいトークンをなくした:** 手順 1 で表示されたハッシュで新しいトークンを取り消し、最初からやり直します。
- **トークンが漏れたおそれがある:** `--keep-old` を付けずに実行します。古いトークンはすぐに取り消され(すべての場所で使えなくなるまで最大で 60 秒ほどかかります)、クライアントは新しいトークンを受け取るまで失敗します。

トークンのスクリプトのすべてのオプションは、README の [API tokens](../../../README.md#api-tokens) にあります。
