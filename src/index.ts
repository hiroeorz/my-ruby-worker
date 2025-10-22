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
