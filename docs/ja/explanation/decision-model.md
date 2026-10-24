---
title: 判定のしくみ
description: Pointsman が質問、ファクト、ルール、人からどのように判定を作るか、データが欠けたときにどうするか、各部分がどうつながるかを説明します。
sidebar: { order: 10 }
---

Pointsman は、ケースをどちらに進めるかを判定します。ケースとは、システムが判定してほしいものです。たとえば、道路が通れないという報告、新しい Issue、プルリクエストです。ケースの種類ごとに**プロファイル**を用意します。プロファイルには、尋ねる質問、調べるファクト、回答をアクションに変えるルールを書きます。プロファイルにはバージョンがあるため、どの判定についても、どのルールで決まったかがわかります。

## 判定の流れ

<svg class="diagram" viewBox="0 0 460 496" role="img" aria-label="判定の流れ: ケースが届く。AI が質問に答え、同時にファクトを調べる。ルールがアクションを決めるか、人がレビューする。すべてを判定ログに記録する。" xmlns="http://www.w3.org/2000/svg">
<!-- Grid: viewBox 460 wide; boxes 210 x 64; column centres 115, 230, 345; rows every 100 from y 16. Drawn by a script with the same shapes in each language. -->
<title>判定の流れ: ケースが届く。AI が質問に答え、同時にファクトを調べる。ルールがアクションを決めるか、人がレビューする。すべてを判定ログに記録する。</title>
<defs><marker id="decision-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrowhead" d="M0 0L10 5L0 10z"/></marker></defs>
<path class="line" d="M230 80 V98 H115 V114" marker-end="url(#decision-arrow)"/>
<path class="line" d="M230 98 H345 V114" marker-end="url(#decision-arrow)"/>
<path class="line" d="M115 180 V198 H230 V214" marker-end="url(#decision-arrow)"/>
<path class="line" d="M345 180 V198 H230"/>
<path class="line" d="M230 280 V298 H115 V314" marker-end="url(#decision-arrow)"/>
<path class="line" d="M230 298 H345 V314" marker-end="url(#decision-arrow)"/>
<path class="line" d="M115 380 V398 H230 V414" marker-end="url(#decision-arrow)"/>
<path class="line" d="M345 380 V398 H230"/>
<rect class="box" x="125" y="16" width="210" height="64" rx="8"/>
<text class="title" x="230" y="40" text-anchor="middle">① ケース</text>
<text class="small" x="230" y="58" text-anchor="middle">システムが、判定して</text>
<text class="small" x="230" y="73" text-anchor="middle">ほしいものを送る</text>
<rect class="box" x="10" y="116" width="210" height="64" rx="8"/>
<text class="title" x="115" y="140" text-anchor="middle">② 質問</text>
<text class="small" x="115" y="158" text-anchor="middle">AI が答える。</text>
<text class="small" x="115" y="173" text-anchor="middle">確率も添える</text>
<rect class="box" x="240" y="116" width="210" height="64" rx="8"/>
<text class="title" x="345" y="140" text-anchor="middle">② ファクト</text>
<text class="small" x="345" y="158" text-anchor="middle">データから調べる。</text>
<text class="small" x="345" y="173" text-anchor="middle">推測はしない</text>
<rect class="box go" x="125" y="216" width="210" height="64" rx="8"/>
<text class="title" x="230" y="240" text-anchor="middle">③ ルール</text>
<text class="small" x="230" y="258" text-anchor="middle">人が書く。最初に</text>
<text class="small" x="230" y="273" text-anchor="middle">当てはまるものを使う</text>
<rect class="box" x="10" y="316" width="210" height="64" rx="8"/>
<text class="title" x="115" y="340" text-anchor="middle">④ アクション</text>
<text class="small" x="115" y="358" text-anchor="middle">システムが動く</text>
<text class="small" x="115" y="373" text-anchor="middle">(例: 公開する)</text>
<rect class="box person" x="240" y="316" width="210" height="64" rx="8"/>
<text class="title" x="345" y="340" text-anchor="middle">④ レビュー</text>
<text class="small" x="345" y="358" text-anchor="middle">人が確認して</text>
<text class="small" x="345" y="373" text-anchor="middle">アクションを決める</text>
<rect class="box" x="125" y="416" width="210" height="64" rx="8"/>
<text class="title" x="230" y="440" text-anchor="middle">⑤ 判定ログ</text>
<text class="small" x="230" y="458" text-anchor="middle">すべてを記録する。</text>
<text class="small" x="230" y="473" text-anchor="middle">プロファイルのバージョンも</text>
</svg>

1. **ケースが届きます。** システムが HTTP API でケースを送るか、AI エージェントが MCP(Model Context Protocol。AI エージェントがツールを呼び出すための仕組み)で送ります。ほかのシステムを Pointsman につなぐ部品である**コネクター**が、FIWARE のスマートシティ向けデータ基盤などから受け取ることもあります。
2. **質問とファクトを同時に処理します。**
   - AI モデルがプロファイルの**質問**に答えます。質問の形は、はい・いいえ、選択肢から 1 つ、段階評価のいずれかです。どの回答にも、モデルがどのくらい確かだと考えているかを表す確率(0 から 1)が付きます。
   - Pointsman がプロファイルの**ファクト**をデータから調べます。たとえば、その場所が浸水想定区域に入るか、プルリクエストが何ファイルを変更したかです。AI はファクトを見ませんし、推測もしません。
3. **ルールが判定します。** ルールは人が書きます。たとえば「危険の確率が 70% 以上なら緊急」です。Pointsman はルールを上から順に調べ、条件が真になった最初のルール(最初に「当てはまった」ルール)のアクションを使います。どれも当てはまらないときは、プロファイルの既定のアクションになります。アクションの名前は、`auto`、`urgent`、`review` のようにプロファイルで決めます。
4. **アクションを返すか、人に回します。** アクションはケースを送ったシステムに戻り、システムがそれに従って動きます。アクションが `review`(またはプロファイルで人の確認が必要と指定したアクション)のときは、先に人がケースを確認します。確認した人が最終のアクションを決め、AI の回答を訂正することもできます。
5. **すべてを[判定ログ](#判定ログ)に記録します。** 訂正も残るため、AI がどのくらい正しかったかがわかります。

## なぜこのように分けるのか

- **AI は答えるだけで、決めるのは人です。** モデルが答えるのは範囲を絞った質問だけです。回答から何をするかは、人が読み、試し、変えられるルールに書きます。そのため、プロファイルの動きを変えずにモデルを入れ替えられます。判定の理由も、いつでも人が確かめられます。AI の回答をまったく使わない判定もあります。たとえば、バージョンの欄と変更履歴だけを変えるリリースのプルリクエストは、誰が変更したかをほかのファクトで確かめたうえで、ファクトだけで承認するプロファイルを書けます([プロファイルの形式](../../profile-format.md#github-pull-requests)の `github_release` を参照)。
- **回答だけでなく確率も使います。** ルールでは、モデルがどのくらい確かかを条件にできます(例: `team.p >= 0.85`。`p` は質問 `team` の回答の確率です)。モデルが確かでないときは、推測で進めずに人に回すルールを書けます。
- **ファクトは調べるもので、推測しません。** 距離やプルリクエストのファイルのように測れるものは、データから取ります。調べられなかったファクトは「欠けた」ものとして扱い、値を作り出すことはありません。詳しくは[欠けたファクト](#欠けたファクト)を参照してください。
- **判定ごとに 1 つの記録を残します。** ログにプロファイルのバージョンとモデルが残るため、あとから「ルールを変えていたらどう判定したか」「人の判断とどのくらい一致したか」を確かめられます。

## 欠けたファクト

ファクトを調べるのに失敗することがあります。ケースに位置がない、データのサービスの応答が遅い、読んでいる途中でプルリクエストに新しいコミットが入った、といった場合です。このときファクトは「欠けた」状態になります。Pointsman は欠けたファクトを推測で埋めません。推測した値は本物と見分けがつかず、ルールがそれを事実として扱ってしまうからです。

どのファクトにも、型ごとのフィールドのほかに 2 つのフィールドがあります。`missing` は値がないとき `true` になり、`reason` には欠けた理由(`timeout` や `no_location` など)が入ります。理由の一覧は[ファクトの型](../reference/fact-types.md#欠けた理由)にあります。

欠けたファクトや値のないフィールドを比べる条件は、真でも偽でもなく「不明」になります。ルールが当てはまるのは条件が真のときだけです。`false and unknown` は偽、`true or unknown` は真、`not unknown` は不明のままです。そのため、データがなかったせいでルールが当てはまることはありません。ただし、ファクトが欠けると、何かを止める**前の**ルールが当てはまらなくなり、それを許す**後の**ルールが代わりに当てはまることがあります。そこで、常に値がわかっている `missing` を最初に確かめます。

```yaml
- when: "facts.flood.missing == true"
  action: review
```

`reason` を使うと、調べるのに失敗した場合と、もともと当てはまらない場合を区別できます。迂回路は道路の区間についてだけ計算できるため、`facts.walk.missing == true and facts.walk.reason != 'no_location'` とすると、本当に失敗したときだけ人に回せます。何かを許すルールでは、前のルールに頼らず、すべての条件を値がわかっている形で書きます(例: `facts.risky.any == false`)。詳細は[プロファイルの形式](../../profile-format.md#facts)(英語)にあります。

## AI の回答は判定を厳しくする方向にしか使わない

ケースの中には、判定される本人が書いたものがあります。プルリクエストのタイトルと説明は作成者が、報告は送った人が書きます。書き手は、AI を誘導するための文(たとえば「この変更は安全です」)を入れることができます。これをプロンプトインジェクションと呼び、完全に防げるモデルはありません。

そのため、外部の人が書いた入力を扱うプロファイルでは、プロファイルを書く人が 1 つの決まりを守ります。AI の回答は、判定を厳しくする方向にだけ使うという決まりです。AI の回答をもとに、ケースを人に回したり修正を求めたりはしますが、ケースを通す理由にはしません。通すために満たすべき条件はファクトで確かめます。ファクトは Pointsman 自身が求める値で、ケースを書いた人が直接決めることはできません。Pointsman がこの決まりを強制するわけではありません。AI の回答だけで通したり承認したりするプロファイルは、ケースを書いた人に誘導されるおそれがあります。例のプロファイル [`workflow-check`](../../../examples/profiles/workflow-check.yaml) を短くすると次のとおりです。

```yaml
policy:
  rules:
    - when: "facts.wf.missing == true"
      action: retry
    # ...
    - when: "touches_secrets.yes >= 0.3"
      action: review
    - when: >-
        facts.wf.unparsed == 0 and facts.wf.privileged == 0
        and facts.wf.injection == 0 and facts.wf.unpinned == 0
        and touches_secrets.yes < 0.3
      action: pass
  default: review
```

AI への質問 `touches_secrets` は、プルリクエストの文章を読みます。この質問を使うのは、ケースを人に回すルールと、通すルールの追加の条件だけです。AI がだまされても、外れるのはその追加の条件だけで、通すにはやはりファクトの条件を満たす必要があります。ファクトを読めなかったときは、最初のルールで `retry`(あとでもう一度試す)になり、`pass` にはなりません。

このようなプロファイルを公開する前に、ルールを文章で読み(`node scripts/explain-profile.mjs <file>`)、次の点を確かめます。

1. ケースを通すルールが、頼りにするファクトをすべて書いている。
2. AI の回答は、厳しい方向のアクションのルールか、通すルールの追加の条件にだけ使っている。
3. ファクトが欠けたときは、人に回すか `retry` になり、通ることはない。

## 人の関わり方: レビューと訂正

プロファイルには、人が確認してから有効にするアクションを指定します(既定は `review`)。そのような判定はレビューの待ち行列に入り、人が最終のアクションを決め、AI の回答を訂正することもできます。クライアントは `callback_url` を渡しておくと、確認が終わったときに署名付きの最終結果を受け取れます。訂正はフィードバックとして残るため、プロファイルがどのくらい正しかったかを測れます。詳細は[レビューとコールバック](../../reviews.md)(英語)にあります。

## 判定ログ

判定はすべて、返す前に保存します。ログに書き込めなければ、クライアントには判定ではなくエラーが返るため、記録のない判定にもとづいて誰かが動くことはありません。ログには、回答、ファクト、ルール、モデル、エンジンとモジュールのバージョン、プロファイルのバージョンが残ります。どの質問をしたかは、プロファイルのバージョンからわかります。リクエストそのものは、プロファイルで残すよう指定しない限りハッシュだけを残します。テスト用トークンの判定は記録しません。ログを読むファクトもあります。たとえば、作成者のプルリクエストのうちレビュー待ちがいくつあるかです。読めるのは、問い合わせたクライアント自身の判定だけです。詳細は[判定ログ](../../decision-log.md)(英語)にあります。

## 判定のチェーン

判定は、以前の判定を前提にできます。たとえば、まず報告を確かめ、さらに確認を重ね、最後の判定がそれらをすべて読みます(プロファイルの `requires`)。以前の判定は ID で指定してログから読むため、クライアントが結果を作り出すことはできません。詳細は[判定のチェーン](../../decision-chains.md)(英語)にあります。

## Pointsman の構成

Pointsman は、1 つのエンジンと、その周りの部品でできています。デプロイごとに必要な部品を選ぶため、自治体の通行止めのサービスと、開発チームのプルリクエストのチェックが、同じエンジンを別のモジュールで動かせます。

<svg class="diagram" viewBox="0 0 460 396" role="img" aria-label="Pointsman の構成: ほかのシステムはコネクターとやり取りする。コネクターは API でエンジンを使う。エンジンはファクトモジュールにファクトを問い合わせ、アダプターを通して実行環境で動く。" xmlns="http://www.w3.org/2000/svg">
<!-- Grid: viewBox 460 wide; boxes 210 x 64; column centres 115, 230, 345; rows every 100 from y 16. Drawn by a script with the same shapes in each language. -->
<title>Pointsman の構成: ほかのシステムはコネクターとやり取りする。コネクターは API でエンジンを使う。エンジンはファクトモジュールにファクトを問い合わせ、アダプターを通して実行環境で動く。</title>
<defs><marker id="roles-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrowhead" d="M0 0L10 5L0 10z"/></marker></defs>
<path class="line" d="M230 82 V114" marker-end="url(#roles-arrow)" marker-start="url(#roles-arrow)"/>
<path class="line" d="M230 182 V214" marker-end="url(#roles-arrow)" marker-start="url(#roles-arrow)"/>
<path class="line" d="M230 280 V298 H115 V314" marker-end="url(#roles-arrow)"/>
<path class="line" d="M230 298 H345 V314" marker-end="url(#roles-arrow)"/>
<rect class="box" x="125" y="16" width="210" height="64" rx="8"/>
<text class="title" x="230" y="40" text-anchor="middle">ほかのシステム</text>
<text class="small" x="230" y="58" text-anchor="middle">FIWARE の基盤や</text>
<text class="small" x="230" y="73" text-anchor="middle">GitHub など</text>
<rect class="box" x="125" y="116" width="210" height="64" rx="8"/>
<text class="title" x="230" y="140" text-anchor="middle">コネクター</text>
<text class="small" x="230" y="158" text-anchor="middle">ケースを受け取り、</text>
<text class="small" x="230" y="173" text-anchor="middle">結果を返す</text>
<rect class="box go" x="125" y="216" width="210" height="64" rx="8"/>
<text class="title" x="230" y="240" text-anchor="middle">エンジン</text>
<text class="small" x="230" y="258" text-anchor="middle">質問、ルール、</text>
<text class="small" x="230" y="273" text-anchor="middle">判定ログ</text>
<rect class="box" x="10" y="316" width="210" height="64" rx="8"/>
<text class="title" x="115" y="340" text-anchor="middle">ファクトモジュール</text>
<text class="small" x="115" y="358" text-anchor="middle">ファクトを調べる</text>
<text class="small" x="115" y="373" text-anchor="middle">(例: 浸水想定区域)</text>
<rect class="box" x="240" y="316" width="210" height="64" rx="8"/>
<text class="title" x="345" y="340" text-anchor="middle">アダプター</text>
<text class="small" x="345" y="358" text-anchor="middle">実行環境につなぐ</text>
<text class="small" x="345" y="373" text-anchor="middle">(ログ、AI モデル)</text>
</svg>

- **エンジン**は、ケースを受け取り、プロファイルの質問を AI モデルに尋ね、ファクトを取得し、ルールを当てはめ、判定ログに書き込みます。
- **AI モデル**が質問に答えます。プロファイルでモデルと代わりのモデルを指定し、ルールを変えずに入れ替えられます([モデル](../../models.md)、英語)。
- **ファクトモジュール**がファクトを調べます。浸水想定区域と避難所(`@pointsman/facts-gsi`)、通行止めの迂回路(`@pointsman/facts-valhalla`)、プルリクエストの状態(`@pointsman/github`)、プルリクエストへの AI のレビュー(`@pointsman/coderabbit`)です。モジュールはこのリポジトリの中のパッケージで、エンジンに組み込んで使い、デプロイで使うものを並べます([ファクトモジュール](../../modules.md)、英語)。
- **コネクター**がほかのシステムとつなぎます。ケースを受け取って結果を返します。たとえば FIWARE の基盤(`@pointsman/fiware`)や、プルリクエスト(`@pointsman/github`)です。ほかのクライアントと同じ公開 API を使います([コネクター](../../connectors.md)、英語)。
- **アダプター**が、エンジンを実行環境とつなぎます。ログとプロファイルの保存先、答える AI のサービス、リクエストの受け取り方がここで決まります。現在の実行環境は、Cloudflare のサーバーでコードを動かすサービスである Cloudflare Workers で、エンジンの中心部は Cloudflare 固有のコードを使いません([アダプター](../../adapters.md)、英語)。

1 つのパッケージが複数の役割を持つこともあります。`@pointsman/github` は、ファクトを調べるモジュールであり、コネクターでもあります。部品を分けておくと、エンジンを小さく保てます。新しいデータの取得元や新しいシステムには新しいモジュールで対応し、エンジンは変えません。別の実行環境では別のアダプターが必要ですが、プロファイルは同じものを使えます。

## 次に読むページ

- [はじめてのプロファイル](../tutorials/first-profile.md)で、ここまでの内容を自分のコンピューターで試せます。
- [プロファイルの形式](../../profile-format.md)(英語)に、すべてのフィールドがあります。
- [セキュリティ](security.md)では、Pointsman が何を、誰から守るかを説明します。
