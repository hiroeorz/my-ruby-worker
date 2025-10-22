# Cloudflare Workers で Ruby Assembly (ruby.wasm) を Hono から呼び出してみたメモ

Cloudflare Workers 上で Hono を使いながら Ruby を動かす実験をしました。最初は `npm create cloudflare@latest` 相当で生成したテンプレートからスタートし、最終的に Ruby の wasm モジュールを同梱して Hono から Ruby を実行する Worker をデプロイし実行できました。
本記事では手順とハマりどころを記録としてまとめておきます。

## 環境

- Node.js 22.21.0
- Wrangler 4.44.0
- Cloudflare Workers (有料プランにアップグレード済み：WASM サイズ上限 10 MiB)
- Hono 4.10.2
- ruby.wasm 3.4 (`@ruby/3.4-wasm-wasi`)

## 1. プロジェクトの初期化と依存パッケージ

1. Cloudflare Workers のテンプレートを作成（例: `npm create cloudflare@latest my-ruby-worker` でプロジェクト名を指定）。
2. 依存ライブラリを追加。

```bash
npm install hono @ruby/wasm-wasi @ruby/3.4-wasm-wasi
```

- `@ruby/wasm-wasi`: Ruby VM をブラウザ/Workers で扱うためのヘルパー。
- `@ruby/3.4-wasm-wasi`: Ruby 3.4 本体 + stdlib を含む WASM モジュール。
- `hono`: Cloudflare Workers で使いやすいルーター。

## 2. TypeScript 設定調整

WASM をモジュールとして import するため、`src/wasm.d.ts` を追加して TypeScript に宣言を与えます。

```ts
// src/wasm.d.ts
declare module '*.wasm' {
	const wasmModule: WebAssembly.Module;
	export default wasmModule;
}
```

TypeScript 設定 (`tsconfig.json`) の `include` に `src/**/*.d.ts` を追加するのを忘れずに。`lib` は `["es2021", "webworker"]` を指定して Workers の WebAssembly API を認識させます。

## 3. Wrangler 設定

単純な ES Modules Worker として動かすので、`wrangler.toml` は最小構成にしました。

```toml
name = "my-ruby-worker"
main = "src/index.ts"
compatibility_date = "2025-10-22"

[observability]
enabled = true
```

## 4. `src/index.ts` の実装

ポイントは以下の通りです。

- `ruby+stdlib.wasm` を直接 import する (`import rubyWasmModule from '@ruby/3.4-wasm-wasi/dist/ruby+stdlib.wasm'`)
- WASI を初期化して Ruby VM を立ち上げる (`RubyVM.instantiateModule`)
- 標準出力・エラーを `@bjorn3/browser_wasi_shim` のメモリベースファイルにリダイレクトし、実行結果と一緒に返す
- ロックを導入し、Ruby VM を 1 リクエストずつ直列で実行 (`withVmLock`)
- Hono を使って `GET /` を定義し、サンプルの Ruby コードを評価して結果を返す

実装は以下のようになります（index.ts）。

```ts
import { Hono } from 'hono';
import { RubyVM } from '@ruby/wasm-wasi';
import { File as WasiFile, OpenFile, PreopenDirectory, WASI } from '@bjorn3/browser_wasi_shim';
import rubyWasmModule from '@ruby/3.4-wasm-wasi/dist/ruby+stdlib.wasm';

type RubyRuntime = {
	vm: RubyVM;
	stdout: WasiFile;
	stderr: WasiFile;
	stdoutFd: OpenFile;
	stderrFd: OpenFile;
};

const decoder = new TextDecoder();
const app = new Hono<{ Bindings: Env }>();

let runtimePromise: Promise<RubyRuntime> | undefined;
let vmLock: Promise<void> = Promise.resolve();

const ensureRuntime = (): Promise<RubyRuntime> => {
	if (!runtimePromise) {
		runtimePromise = createRuntime(rubyWasmModule).catch((error) => {
			runtimePromise = undefined;
			throw error;
		});
	}
	return runtimePromise;
};

const createRuntime = async (module: WebAssembly.Module): Promise<RubyRuntime> => {
	const stdinFd = new OpenFile(new WasiFile([]));
	const stdout = new WasiFile([]);
	const stderr = new WasiFile([]);
	const stdoutFd = new OpenFile(stdout);
	const stderrFd = new OpenFile(stderr);
	const wasi = new WASI([], [], [stdinFd, stdoutFd, stderrFd, new PreopenDirectory('/', new Map())]);
	const { vm } = await RubyVM.instantiateModule({
		module,
		wasip1: wasi,
	});
	return {
		vm,
		stdout,
		stderr,
		stdoutFd,
		stderrFd,
	};
};

const withVmLock = async <T>(fn: () => Promise<T>): Promise<T> => {
	const previous = vmLock;
	let release: () => void = () => undefined;
	vmLock = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		return await fn();
	} finally {
		release();
	}
};

const resetBuffer = (file: WasiFile, fd: OpenFile): void => {
	file.data = new Uint8Array();
	fd.file_pos = 0n;
};

const bufferToText = (file: WasiFile): string => decoder.decode(file.data);

const runRuby = async (code: string) => {
	const runtime = await ensureRuntime();
	return withVmLock(async () => {
		resetBuffer(runtime.stdout, runtime.stdoutFd);
		resetBuffer(runtime.stderr, runtime.stderrFd);
		const value = runtime.vm.eval(code);
		return {
			stdout: bufferToText(runtime.stdout),
			stderr: bufferToText(runtime.stderr),
			result: value.toString(),
		};
	});
};

app.get('/', async (c) => {
	const script = [
		"str = 'Ruby(with WASM/WASI) running on Cloudflare Workers !'",
		'sum = 1 + 2 + 3',
		'"Ruby executed add numbers: #{sum} | #{str}"',
	].join('\n');
	const execution = await runRuby(script);
	return c.json({
		message: 'Hello from Ruby(with WASM/WASI) running on Cloudflare Workers !',
		...execution,
	});
});

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return app.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
```

## 5. サイズ制限とプランの話

- `ruby+stdlib.wasm` はおよそ 9 MB (gzip) 程度あるため、無料プラン (Free) の 3 MiB バンドル上限を超えてしまいます。
- 解決策として Workers を有料プラン（Workers Paid / Starter など）にアップグレードし、バンドル上限を 10 MiB に引き上げました。Cloudflare ダッシュボードの「Workers & Pages」からプラン変更が可能です。
- 一度は R2 に wasm を置いて fetch→compile する方法も試みましたが、`WebAssembly.compile()` が Cloudflare Workers では sandboxed / wasm 生成禁止になっていたため断念。現状は wasm をバンドルしてアップロードする方式がシンプルです。

## 6. ローカル実行と疎通確認

まずはローカルでテスト。

```bash
npm run dev
```

`http://127.0.0.1:8787/` にアクセスするとサンプルの Ruby 実行結果が JSON で返ってきます。

## 7. デプロイ

Cloudflare workers にデプロイします。

```bash
export CLOUDFLARE_ACCOUNT_ID=xxxxxxxxxx(自分のアカウントID)
npm run deploy
```

- 有料プランに切り替えていれば、`Total Upload` が 9 MiB 超でもエラーなくアップロードされます。
- デプロイ後は `https://<worker name>.<account>.workers.dev/` （デプロイ結果に表示されます）にアクセスすれば、Cloudflare 上でも Ruby 実行結果が確認できます。

実際の実行結果

```javascript
// 20251022231223
// https://my-ruby-worker.xxxxxxxx.workers.dev/

{
  "message": "Hello from Ruby(with WASM/WASI) running on Cloudflare Workers !",
  "stdout": "",
  "stderr": "",
  "result": "Ruby executed add numbers: 6 | Ruby(with WASM/WASI) running on Cloudflare Workers !"
}
```

## 8. まとめ

- Hono + `@ruby/wasm-wasi` を使うことで、Cloudflare Workers 上でも Ruby 環境を持ち込める。
- Ruby wasm を含むバンドルは 9 MiB 前後と大きめなので、無料プランではサイズ制限に引っかかる → 有料プランにアップグレードが必要。
- Cloudflare Workers では `WebAssembly.compile()` に制限があるため、wasm をリクエスト時にコンパイルするのではなく、あらかじめバンドル済みモジュールを利用するのが確実。

以上、Cloudflare Workers での Ruby Assembly 実行メモでした。
