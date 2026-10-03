# ワクワクルーレット

好きな候補でルーレットを作って、スタート／ストップで抽選できる Web アプリです。

## 機能

- **Google アカウントでのログイン必須**（Firebase Authentication）
- **ルーレットを何個でも作成・保存**（Cloud Firestore にユーザーごとに保存。どの端末からでも同じデータ）
- 候補の追加・編集・削除、色の変更、**当たりやすさ（重み 1〜10）**の設定
- **まとめて登録**（1行1候補で貼り付け）、**テンプレート**から作成、ルーレットの**複製**
- スタートで回転 → ストップで減速して停止（当たりは `crypto.getRandomValues` で決定）
- 針のカチカチ・効果音・電飾・紙吹雪・結果ポップアップの演出
- 「当たった候補は次回から外す」モード、抽選履歴（最新50件）
- スペースキーでスタート／ストップ、スマホ対応

ビルド不要の静的サイトです（`index.html` / `style.css` / `app.js`）。

## セットアップ（Firebase）

1. [Firebase コンソール](https://console.firebase.google.com/) でプロジェクトを作成
2. **Authentication** → ログイン方法 → **Google** を有効化
3. **Authentication** → 設定 → **承認済みドメイン** に公開先ドメインを追加
   （例：`<ユーザー名>.github.io`。ローカル確認なら `localhost` は既定で登録済み）
4. **Firestore Database** を作成し、「ルール」に `firestore.rules` の内容を貼り付けて公開
5. プロジェクトの設定 → マイアプリ → ウェブアプリを追加し、表示された設定値を
   `firebase-config.js` に貼り付け

> `apiKey` などは公開されても問題ない値です。データは Firestore ルールで
> 「ログイン本人のみ読み書き可」に制限されています。

`firebase-config.js` が未設定の間は、ログイン画面に「ブラウザ保存のデモモード」が表示され、
動作確認ができます（設定後はデモモードは表示されず Google ログインが必須になります）。

## ローカルで動かす

ES Modules を使っているため、ファイルを直接開くのではなく HTTP サーバー経由で開きます。

```sh
python3 -m http.server 8000
# http://localhost:8000/roulette/ を開く
```

## データ構造

`users/{uid}/roulettes/{rouletteId}`

```json
{
  "id": "…",
  "name": "今日のランチ",
  "items": [{ "id": "…", "label": "ラーメン", "color": "#ff4fa3", "weight": 1, "excluded": false }],
  "history": [{ "label": "ラーメン", "at": 1730000000000 }],
  "removeWinner": false,
  "createdAt": 1730000000000,
  "updatedAt": 1730000000000
}
```
