# my-ruby-worker

Cloudflare Workers 上で Ruby WASM (`@ruby/3.4-wasm-wasi`) を動かす実験的な Worker です。Hono を利用して HTTP ルーティングを行い、`GET /` でサンプルの Ruby スクリプトを評価して結果を JSON で返します。

## 必要条件

- Node.js 22.x 以上
- npm 10.x 以上
- Wrangler 4.x (`npm install` 後に同梱のバージョンを使用)
- Cloudflare Workers 有料プラン（`ruby+stdlib.wasm` をバンドルすると 3 MiB を超えるため）

## セットアップ

```bash
npm install
```

## 開発サーバー

```bash
npm run dev
```

`http://127.0.0.1:8787/` にアクセスすると、Ruby コードの評価結果が JSON で表示されます。Ruby の標準出力は `stdout`、戻り値は `result` フィールドに格納されます（環境によっては `puts` 後に `STDOUT.flush` が必要になる場合があります）。

## デプロイ

```bash
npm run deploy
```

有料プランにアップグレード済みであれば、WASM を含むバンドルが 10 MiB までアップロードできます。

## 実装のポイント

- `src/index.ts` で Ruby VM を初期化し、WASI の stdout/stderr をメモリ上のバッファにリダイレクトして結果を取得しています。
- Ruby VM は初回リクエスト時に生成し、`withVmLock` で直列実行にすることで同一インスタンスの再利用時も安全に動作します。
- セキュリティを考慮し、公開エンドポイントから任意の Ruby コードを実行する機能は提供していません。

## 参考

- Zenn 記事草稿: `zenn.md`
- `wrangler.toml` に Workers のエントリポイントや互換性日付を記載しています。***
