---
title: Pointsman の構成
description: エンジン、ファクトモジュール、コネクター、アダプターと、それらを分けている理由を説明します。
sidebar: { order: 20 }
---

Pointsman は、1 つのエンジンと、その周りの部品でできています。デプロイごとに必要な部品を選ぶため、自治体の通行止めのサービスと、開発チームのプルリクエストのチェックが、同じエンジンを別のモジュールで動かせます。

## 部品

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

- **エンジン**は、ケースを受け取り、プロファイルの質問を AI モデルに尋ね、ファクトを取得し、ルールを当てはめ、判定ログに書き込みます。ファクトの出どころや、ケースを送ってきたシステムのことは知りません。
- **ファクトモジュール**はファクトを調べます。モジュールはこのリポジトリの中のパッケージで、エンジンに組み込んで使います(npm では公開していません)。たとえば浸水想定区域と避難所(`@pointsman/facts-gsi`)、通行止めの迂回路(`@pointsman/facts-valhalla`)、プルリクエストの状態(`@pointsman/github`)です。詳しくは[ファクトモジュール](../../modules.md)を参照してください。
- **コネクター**はほかのシステムとつなぎます。そのシステムからケースを受け取り、結果を返します。たとえば FIWARE の基盤(`@pointsman/fiware`)や、プルリクエストのチェック(`@pointsman/github`)です。コネクターも、ほかのクライアントと同じ公開 API を使います。詳しくは[コネクター](../../connectors.md)を参照してください。
- **アダプター**は、エンジンを動かす実行環境とつなぎます。判定ログとプロファイルの保存先、答える AI のサービス、リクエストの受け取り方がここで決まります。現在の実行環境は Cloudflare Workers です。詳しくは[アダプター](../../adapters.md)を参照してください。

1 つのパッケージが複数の役割を持つこともあります。`@pointsman/github` は、ファクトを調べるモジュールであり、コネクターでもあります。

## 部品を分けている理由

- **エンジンを小さく保つため。** 新しいデータの取得元や新しいシステムには、新しいモジュールで対応します。エンジンは変えません。どのデプロイでもエンジンは同じです。
- **デプロイごとに選べるようにするため。** デプロイでは使うモジュールをバージョンを固定して並べ、各判定には使ったエンジンとファクトモジュールのバージョンが記録されます。
- **特定の実行環境に縛られないため。** エンジンの中心部は Cloudflare 固有のコードを使いません。型と import を調べるチェックで、これを確かめています。別の実行環境では別のアダプターが必要ですが、プロファイルとルールは同じものを使えます。

どのモジュールとコネクターがあり、それぞれのファクトの型、アクション、設定が何かは、[ファクトの型](../reference/fact-types.md)と[コネクター](../reference/connectors.md)にまとめています。
