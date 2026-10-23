---
title: 判定のモデル
description: Pointsman が質問、ファクト、ルール、人からどのように判定を作るか、そしてなぜそう分けているかを説明します。
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
   - Pointsman がプロファイルの**ファクト**をデータから調べます。たとえば、その場所が浸水想定区域に入るか、プルリクエストが何ファイルを変更したかです。Pointsman 自身の判定ログを読むファクトもあります。たとえば、作成者のプルリクエストのうちレビュー待ちがいくつあるかです。このようなファクトが読めるのは、問い合わせたクライアント自身の判定だけです。AI はファクトを見ませんし、推測もしません。
3. **ルールが判定します。** ルールは人が書きます。たとえば「危険の確率が 70% 以上なら緊急」です。Pointsman はルールを上から順に調べ、条件が真になった最初のルール(最初に「当てはまった」ルール)のアクションを使います。どれも当てはまらないときは、プロファイルの既定のアクションになります。アクションの名前は、`auto`、`urgent`、`review` のようにプロファイルで決めます。
4. **アクションを返すか、人に回します。** アクションはケースを送ったシステムに戻り、システムがそれに従って動きます。アクションが `review`(またはプロファイルで人の確認が必要と指定したアクション)のときは、先に人がケースを確認します。確認した人が最終のアクションを決め、AI の回答を訂正することもできます。
5. **すべてを記録します。** 判定ログには、回答、ファクト、当てはまったルール、モデル、エンジンとモジュールのバージョン、プロファイルのバージョンが残ります。どの質問をしたかは、プロファイルのバージョンからわかります。リクエストそのものは、プロファイルで残すよう指定しない限り、ハッシュだけを残します。訂正の記録から、AI がどのくらい正しかったかがわかります。

## なぜこのように分けるのか

- **AI は答えるだけで、決めるのは人です。** モデルが答えるのは範囲を絞った質問だけです。回答から何をするかは、人が読み、試し、変えられるルールに書きます。そのため、プロファイルの動きを変えずにモデルを入れ替えられます。判定の理由も、いつでも人が確かめられます。AI の回答をまったく使わない判定もあります。たとえば、バージョンの欄と変更履歴だけを変えるリリースのプルリクエストは、誰が変更したかをほかのファクトで確かめたうえで、ファクトだけで承認するプロファイルを書けます([プロファイルの形式](../../profile-format.md#github-pull-requests)の `github_release` を参照)。
- **回答だけでなく確率も使います。** ルールでは、モデルがどのくらい確かかを条件にできます(例: `team.p >= 0.85`。`p` は質問 `team` の回答の確率です)。モデルが確かでないときは、推測で進めずに人に回すルールを書けます。
- **ファクトは調べるもので、推測しません。** 距離やプルリクエストのファイルのように測れるものは、データから取ります。調べられなかったファクトは「欠けた」ものとして扱い、値を作り出すことはありません。詳しくは[欠けたファクト](missing-facts.md)を参照してください。
- **判定ごとに 1 つの記録を残します。** ログにプロファイルのバージョンとモデルが残るため、あとから「ルールを変えていたらどう判定したか」「人の判断とどのくらい一致したか」を確かめられます。

## 次に読むページ

- [プロファイルの概要](../reference/profiles.md)では、プロファイルの書き方の全体像を示します。
- [AI の回答は判定を厳しくする方向にしか使わない理由](stricter-only.md)では、外部の人が書いた入力を扱うとき、AI の回答で人に回すことはあっても通すことはない理由を説明します。
- [Pointsman の構成](architecture.md)では、エンジン、モジュール、コネクター、アダプターの関係を示します。
