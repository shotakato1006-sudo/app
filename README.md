# 東京湾ふねウォッチ

東京湾にいる「面白い船」（客船・巨大船・ヨット・働く船など）だけを地図に出し、
クリックすると AI が船の解説をしてくれるパソコン向けのページです。

## ローカル版（おすすめ：ほぼリアルタイム）

自分のパソコンで小さなサーバーを動かし、aisstream.io にずっと接続したままにします。
船の位置は数秒〜十数秒で更新されます。

1. Node.js（バージョン 22 以上）を https://nodejs.org からインストール
2. このフォルダの `.env.example` をコピーして `.env` という名前にし、API キーを書く
   - `AISSTREAM_API_KEY` … https://aisstream.io に GitHub でログイン → API Keys で作成（無料）
   - `ANTHROPIC_API_KEY` … https://console.anthropic.com で作成（有料・任意）
3. 起動
   - Windows: `start.bat` をダブルクリック
   - Mac: `start.command` をダブルクリック
   - どちらでも: このフォルダで `npm install` → `node server.mjs`
4. ブラウザで http://localhost:8080 が開きます（開かなければ手で開く）

止めるときは黒い画面で Ctrl+C を押すか、画面を閉じます。

### スマホで見る（同じ Wi-Fi のとき）

パソコンでサーバーを動かしたまま、黒い画面に出る
「スマホで見る（同じWi-Fiで）: http://192.168.x.x:8080」のアドレスをスマホのブラウザで開きます。
Windows で「ファイアウォールでブロックされています」と出たら「アクセスを許可する」を押してください。
スマホから見られないようにしたいときは `.env` に `PHONE=0` と書きます。

## GitHub Pages 版（15分ごと更新）

`.github/workflows/ais.yml` が 15 分ごとにデータを集めて公開します。
リポジトリの Secrets に `AISSTREAM_API_KEY` と `ANTHROPIC_API_KEY` を登録し、
Settings → Pages の Source を「GitHub Actions」にすると動きます（main ブランチのみ）。
