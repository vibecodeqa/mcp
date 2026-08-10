/**
 * Stdio smoke test for the built MCP server (issue #4).
 *
 * `tsc` proves the code compiles. It cannot see whether the binary starts, the
 * stdio transport negotiates, the handshake advertises the right version, or a
 * single tool is reachable — and a wrong handshake version has already shipped
 * once (see the comment at src/index.ts `packageVersion()`).
 *
 * Runner: `node --test`, not vitest. This repo has no test runner and only two
 * devDependencies; a raw JSON-RPC-over-stdio driver plus the built-in runner
 * adds zero dependencies to the release path. (The MCP SDK ships a client, but
 * driving the server with the same library it is built on would assert less.)
 *
 * Deliberately offline: no tool that shells out to `@vibecodeqa/cli` is
 * *executed* here — putting an `npx --yes` network install on the publish gate
 * would recreate the third-party-flake problem. Scan tools are asserted as
 * registered; only pure-filesystem tools are called.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const serverEntry = join(repoRoot, "dist", "index.js");
const fixtureDir = join(here, "fixture");
const vendorDir = join(fixtureDir, "node_modules");

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

/**
 * The expected tool set, derived from the source rather than hardcoded — a
 * literal list would go stale the moment a tool is added, and would then be
 * "passing" while asserting nothing about the new tool.
 */
function toolNamesFromSource() {
	const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf8");
	const names = [...src.matchAll(/server\.tool\(\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
	const registrations = (src.match(/server\.tool\(/g) ?? []).length;
	// If a registration ever stops matching the name pattern, fail loudly rather
	// than silently shrinking the expected set.
	strictEqual(
		names.length,
		registrations,
		`parsed ${names.length} tool names from ${registrations} server.tool( calls — the parser missed one`,
	);
	ok(names.length > 0, "no tools parsed out of src/index.ts");
	return names;
}

/** Minimal JSON-RPC-over-stdio client. MCP stdio framing is newline-delimited JSON. */
class StdioClient {
	constructor(entry) {
		this.nextId = 1;
		this.pending = new Map();
		this.stderr = "";
		this.buf = "";
		this.proc = spawn(process.execPath, [entry], {
			cwd: repoRoot,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});
		this.proc.stdout.setEncoding("utf8");
		this.proc.stdout.on("data", (chunk) => this.#onData(chunk));
		this.proc.stderr.setEncoding("utf8");
		this.proc.stderr.on("data", (chunk) => { this.stderr += chunk; });
		this.exited = new Promise((resolve) => {
			this.proc.on("exit", (code, signal) => resolve({ code, signal }));
		});
	}

	#onData(chunk) {
		this.buf += chunk;
		let nl;
		while ((nl = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, nl).trim();
			this.buf = this.buf.slice(nl + 1);
			if (!line) continue;
			let msg;
			try { msg = JSON.parse(line); } catch { continue; } // ignore non-JSON noise
			if (msg.id != null && this.pending.has(msg.id)) {
				const { resolve, reject, timer } = this.pending.get(msg.id);
				this.pending.delete(msg.id);
				clearTimeout(timer);
				if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
				else resolve(msg.result);
			}
		}
	}

	request(method, params, timeoutMs = 15_000) {
		const id = this.nextId++;
		const payload = { jsonrpc: "2.0", id, method, params };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`timed out after ${timeoutMs}ms waiting for ${method}; stderr: ${this.stderr}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
		});
	}

	notify(method, params) {
		this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	async close() {
		for (const { timer } of this.pending.values()) clearTimeout(timer);
		this.pending.clear();
		this.proc.stdin.end();
		this.proc.kill();
		await this.exited;
	}
}

/** The text payload of a tools/call result. */
function resultText(result) {
	ok(Array.isArray(result?.content), "tool result has no content array");
	const first = result.content[0];
	strictEqual(first?.type, "text", "expected a text content block");
	return first.text;
}

describe("mcp stdio smoke test", () => {
	let client;
	let initResult;

	before(async () => {
		try {
			accessSync(serverEntry, constants.F_OK);
		} catch {
			throw new Error(`${serverEntry} is missing — run \`pnpm build\` before \`pnpm test\``);
		}
		// Built here rather than committed: `node_modules` is gitignored, so a
		// checked-in copy would not survive a clone — and then the "walk skips
		// vendor dirs" assertion below would pass without testing anything.
		mkdirSync(vendorDir, { recursive: true });
		writeFileSync(join(vendorDir, "ignored.ts"), "export const shouldNotBeListed = 1;\n");
		client = new StdioClient(serverEntry);
		initResult = await client.request("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "vcqa-smoke-test", version: "1.0.0" },
		});
		client.notify("notifications/initialized", {});
	});

	after(async () => {
		if (client) await client.close();
		rmSync(vendorDir, { recursive: true, force: true });
	});

	it("ships an executable entry point with a node shebang", () => {
		const firstLine = readFileSync(serverEntry, "utf8").split("\n", 1)[0];
		strictEqual(firstLine.trim(), "#!/usr/bin/env node", "dist/index.js lost its shebang");
		// publish.yml chmods this as a separate step; if that step drifts,
		// `npx @vibecodeqa/mcp` fails at exec, after publish.
		accessSync(serverEntry, constants.X_OK);
	});

	it("completes the initialize handshake as vcqa", () => {
		strictEqual(initResult.serverInfo?.name, "vcqa");
	});

	it("advertises the package.json version in the handshake", () => {
		// This is the regression that already shipped: package.json 0.5.1 against
		// a hardcoded handshake 0.5.0. It compiles cleanly; only a handshake sees it.
		strictEqual(initResult.serverInfo?.version, pkg.version);
	});

	it("lists exactly the tools registered in src/index.ts", async () => {
		const expected = toolNamesFromSource();
		const { tools } = await client.request("tools/list", {});
		const actual = tools.map((t) => t.name);
		deepStrictEqual([...actual].sort(), [...expected].sort());
		strictEqual(actual.length, expected.length);
	});

	it("gives every tool a non-empty description and an input schema", async () => {
		const { tools } = await client.request("tools/list", {});
		for (const t of tools) {
			ok(t.description && t.description.length > 0, `${t.name} has no description`);
			ok(t.inputSchema, `${t.name} has no inputSchema`);
		}
	});

	it("calls vcqa_list_files against a fixture (proves wiring, not just registration)", async () => {
		const result = await client.request("tools/call", {
			name: "vcqa_list_files",
			arguments: { path: fixtureDir },
		});
		const payload = JSON.parse(resultText(result));
		strictEqual(payload.root, fixtureDir);
		ok(payload.total >= 2, `expected the fixture's files, got ${payload.total}`);
		ok(payload.files.includes("alpha.ts"), `alpha.ts missing from ${JSON.stringify(payload.files)}`);
		ok(payload.files.includes("beta.ts"), `beta.ts missing from ${JSON.stringify(payload.files)}`);
		ok(!payload.files.some((f) => f.includes("node_modules")), "walk should skip node_modules");
		ok(!payload.files.includes("node_modules/ignored.ts"), "vendor dir leaked into the inventory");
	});

	it("calls vcqa_grep against a fixture", async () => {
		const result = await client.request("tools/call", {
			name: "vcqa_grep",
			arguments: { path: fixtureDir, pattern: "needleInTheFixture" },
		});
		const text = resultText(result);
		ok(text.includes("alpha.ts"), `expected a hit in alpha.ts, got: ${text}`);
		ok(!text.includes("beta.ts"), `beta.ts should not match, got: ${text}`);
	});

	it("calls vcqa_read_file against a fixture and numbers the lines", async () => {
		const result = await client.request("tools/call", {
			name: "vcqa_read_file",
			arguments: { path: fixtureDir, file: "beta.ts" },
		});
		const text = resultText(result);
		ok(/^\s*1\s{2}/.test(text), `expected line-numbered output, got: ${text.slice(0, 80)}`);
		ok(text.includes("betaMarker"), "fixture content missing from read_file output");
	});

	it("refuses to read outside the project root", async () => {
		const result = await client.request("tools/call", {
			name: "vcqa_read_file",
			arguments: { path: fixtureDir, file: "../../package.json" },
		});
		ok(result.isError, "path escape should be rejected");
	});

	it("explains a check without running a scan", async () => {
		// vcqa_explain reads CHECK_META from @vibecodeqa/schema only — no engine
		// spawn — so it also proves the schema dependency resolves at runtime.
		const result = await client.request("tools/call", {
			name: "vcqa_explain",
			arguments: { check: "complexity" },
		});
		const payload = JSON.parse(resultText(result));
		strictEqual(payload.name, "complexity");
		ok(payload.what, "explain returned no description");
		ok(payload.fix, "explain returned no recommendation");
	});
});
