# AI VTuberのマイクラ配信（MVP）

ゲーム好きなAI VTuberが、Minecraft Java Edition のクリエイティブワールドを**自分の好みで**遊ぶための仕組みです。
仕様は「MVP実装仕様 v1.0」に従っています。いまは **作業順1（マイクラ接続の技術試験）** と、**AIが自分で遊ぶ最小ループ** まで実装済みです。

```
Minecraft + VTuber Bridge Mod  <──(127.0.0.1:25599 / 1行1JSON)──>  vtuber/（AIの進行）
   状態・操作・結果                                             ├ キャラ設定 character.json
                                                               ├ ワールド別メモ data/worlds/
                                                               └ 発話（画面表示 / VOICEVOX）
```

| 置き場所 | 中身 |
|---|---|
| `minecraft-mod/` | Fabric クライアントMod。配信に映るプレイヤーの状態を読み、移動・視点変更・設置/破壊を行い、実際の結果を返す |
| `vtuber/` | Python。状態→遊びを選ぶ（Claude）→操作→結果を見て次へ。発話、手動テスト用CLI |
| `broadcast/` | （作業順2で追加）OBSシーンと立ち絵 |
| `data/` | ワールド別メモと検証ログ（Git管理外） |

## 必要なもの（Windows PC）

- Minecraft Java Edition **1.21.11** と [Fabric Loader](https://fabricmc.net/use/installer/)（0.18 以上）
- [Fabric API](https://modrinth.com/mod/fabric-api)（1.21.11 用）
- Python 3.10 以上
- Anthropic の APIキー（環境変数 `ANTHROPIC_API_KEY`）
- （任意）[VOICEVOX](https://voicevox.hiroshiba.jp/)：日本語の声を出す場合

## セットアップ

### 1. Modをビルドして入れる

```powershell
cd minecraft-mod
.\gradlew.bat build          # Java 21 が必要
```

`minecraft-mod/build/libs/vtuber-bridge-0.1.0.jar` と Fabric API の jar を、`%APPDATA%\.minecraft\mods\` に置きます。

### 2. Python側

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
setx ANTHROPIC_API_KEY "sk-ant-..."   # 新しいターミナルから有効
```

### 3. Minecraftの設定（初回だけ）

- **フォーカスが外れても止まらないようにする**：ゲーム中に `F3 + P`（"Pause on lost focus: disabled" と出ればOK）。OBSやターミナルを触ってもメニューが開かなくなります。
- AI操作の停止キーは **F8**（設定 → 操作設定 → 「VTuber Bridge」で変更可）。

## 起動・停止

1. 人がMinecraftを起動し、Fabric 1.21.11 でワールドに入る（初回は**コピーした検証用ワールド**で）。
2. 接続確認：
   ```powershell
   python -m vtuber.cli state
   ```
3. AIに遊んでもらう：
   ```powershell
   python -m vtuber.play                    # 発話はターミナルに表示
   python -m vtuber.play --voice voicevox   # VOICEVOX起動済みなら声で話す
   ```
4. 止める：
   - **ゲーム内で F8** … すぐにAI操作を止め、押下中の入力を解除（もう一度F8で再開）。
   - **ターミナルで Ctrl+C** … 操作を止めて入力を解除し、今日のメモを `data/worlds/` に保存して終了。
   - ゲームとの連携が切れた／ワールドを出た／メニューを開いたときも、Mod側で操作を中断し入力を解除します。
   - OBSの送出は人がOBSで独立して止めます。

## 初回確認（作業順1：マイクラ接続の技術試験）

検証用ワールドで、開けた平地に立ってから：

```powershell
python -m vtuber.cli check
```

「状態取得 → 視点変更 → 移動 → 結果確認 → 停止（入力が残らないか）」を通しで実行し、結果を `data/logs/check-*.json` に残します。
そのあと手で **F8 で止まる/再開できる** ことも確認してください。

個別の操作も試せます：

```powershell
python -m vtuber.cli look --delta-yaw 90 --ms 1500    # 右へゆっくり90度
python -m vtuber.cli look --pitch -20                  # 少し上を見る
python -m vtuber.cli move --direction forward --ms 2000
python -m vtuber.cli goto 120 -40                      # その座標へ歩く
python -m vtuber.cli place 10 64 -3 --block minecraft:oak_planks
python -m vtuber.cli break 10 64 -3
python -m vtuber.cli stop
```

## 連携の取り決め（Mod ⇔ Python）

1行に1つのJSON。要求には `id` を付け、同じ `id` で応答が返ります。

| 送る | 返る |
|---|---|
| `{"type":"hello"}` | `{"type":"hello","protocol":1,"ai_enabled":true,"world_id":"local:..."}` |
| `{"type":"get_state","id":"s1"}` | `{"type":"state","id":"s1","state":{ワールドID, 確認時刻, 現在地, 視点, 足元, バイオーム, 時間帯, 視線の先, 周囲のブロックと生き物（見えているか）}}` |
| `{"type":"act","id":"a1","world_id":"local:...","action":"look","args":{...}}` | `{"type":"accepted","id":"a1"}` → 終了時 `{"type":"result","id":"a1","ok":true,"observed":{実際の変化},"reason":失敗理由}` |
| `{"type":"stop","id":"x"}` | 実行中の操作を中断して入力解除 → `{"type":"stopped","id":"x"}` |

Modからのイベント：`ai_disabled` / `ai_enabled`（F8）、`world_joined` / `world_left`。

操作（`action`）：`look`, `move`, `move_to`, `jump`, `wait`, `place_block`, `break_block`。
操作は同時に1つだけで、結果を受けてから次を選びます。主な失敗理由：`busy`, `ai_disabled`, `screen_open`, `world_mismatch`, `too_far`, `stuck`, `occupied`, `not_creative`, `stopped_by_human`, `connection_lost`。

## AIの進行（vtuber/）

- `character.json` … 好み・話し方・遊び方（名前・外見・声は実演を見て決める）。
- `brain.py` … 状態・最近の流れ・前回メモ・今日の興味から、次の1手とひとことを決める（Claude、`claude-opus-5-5`）。行動と発話は同じ呼び出しで決めるので、「なぜそれを選んだか」を共有します。話すのは実際に状態や結果に出てきたものだけ。
- `voice.py` … 発話は別スレッドで再生し、プレイを止めません。新しい発話が来たら未再生の古い発話は捨て、8秒より古い発話も捨てます。
- `memory.py` … 終了時に「遊んだ場所・起きたこと・気に入ったこと・次にやりたいこと」を `data/worlds/<ワールドID>.json` へ。1手ごとの「状態・選択・結果」は `data/logs/play-*.jsonl` へ。

`python -m vtuber.play --help` でモデル・考える深さ（`--effort`）・今日の興味などを変えられます。

## 次にやること

- 作業順2：OBSシーンと立ち絵（`broadcast/`）、VOICEVOXの話者選び、短い録画で一場面を確認
- 実機での接続方式・応答時間の確認結果を見て、対象バージョンとモデル設定を確定
