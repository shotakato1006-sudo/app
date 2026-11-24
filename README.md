# あしあと

Googleマップのタイムライン（位置履歴）を読み込んで、行った場所・旅の記録を見返す Android アプリ。

- 旅の自動まとめ（自宅から一定距離以上離れた日をまとめる。距離は設定で変更可）
- 日々のカレンダー、1日ごとの地図と行程、メモ
- 全期間の地図、都道府県・市区町村・国の記録
- 場所に名前を付ける、バックアップ／復元

対応ファイル: Android の Timeline.json、iPhone の location-history.json、Googleテイクアウトの Records.json・Semantic Location History（ZIP のままでも可）、このアプリのバックアップ。

データは端末内（アプリ専用領域）に保存。地名は同梱の境界データで判定するのでネット不要。
「詳しい地図」をオンにしたときだけ OpenStreetMap の地図画像を取得する。

## ビルド

```
ANDROID_HOME=/path/to/android-sdk gradle assembleRelease
```

署名鍵はリポジトリに含めていない。`keystore.properties`（storeFile / storePassword / keyAlias / keyPassword）を置くとその鍵で署名する。
アップデート版は同じ鍵で署名しないとインストールできない。

`tools/make_sample.py` で動作確認用の架空データを作れる。

## データの出典

- 市区町村・都道府県: 国土数値情報（行政区域データ）、japan-map-selector（MIT）経由
- 国境: Natural Earth（world-atlas）
- 地図表示: Leaflet、topojson-client
