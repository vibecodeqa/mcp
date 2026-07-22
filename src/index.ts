#!/usr/bin/env node
/**
 * VibeCode QA MCP Server
 *
 * Gives AI coding agents real-time code health context — the same data the
 * VibeCode monitor shows — so a desktop copilot and an external agent (Claude
 * Code, Cursor, …) share one toolbelt over the same project.
 * Tools:
 *   vcqa_score       — Quick score + grade (fastest, uses cache)
 *   vcqa_scan        — Full scan with all 34 check results
 *   vcqa_file_health — Get issues for a specific file
 *   vcqa_check       — Get details for a specific check
 *   vcqa_explain     — Explain what a check measures and how to fix it
 *   vcqa_fix         — AI-powered fix for code issues (needs ANTHROPIC_API_KEY)
 *   vcqa_delta       — Score/issue delta vs the previous scan
 *   vcqa_read_file   — Read a source file (numbered) — the exact code on screen
 *   vcqa_list_files  — List project files (the Files-view inventory)
 *   vcqa_grep        — Regex-search the project's source
 *   vcqa_graph       — Module dependency graph (the Graph view's nodes/edges)
 *   vcqa_architecture — React layers + inter-layer call flow (the Architecture view; needs graphify)
 *   vcqa_callflow    — Real function-call tree from an entry symbol (the Flow view; needs graphify)
 *   vcqa_sequence    — Static sequence diagram (Mermaid) for a symbol's call order (needs graphify)
 *   vcqa_app_state   — The running monitor's live folder + open page
 *   vcqa_copilot_thread — The in-app copilot's conversation for a page
 *   vcqa_copilot_send   — Text a page's copilot on the user's behalf; get its reply
 *
 * Usage:
 *   npx @vibecodeqa/mcp                  # stdio transport (for Claude Code, Cursor, etc.)
 *   Add to claude_desktop_config.json:
 *   { "mcpServers": { "vcqa": { "command": "npx", "args": ["@vibecodeqa/mcp"] } } }
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { buildArchitecture, stripHiddenNodes, type GraphifyGraph } from "./architecture.js";
import { buildCallGraph, entryPoints, resolveRootMatches, traceFrom } from "./callflow.js";
import { buildSequence, toMermaid } from "./sequence.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

interface ScanReport {
	score: number;
	grade: string;
	version?: string;
	checks: {
		name: string;
		score: number;
		grade: string;
		details: Record<string, unknown>;
		issues: { severity: string; message: string; file?: string; line?: number; rule?: string }[];
		duration: number;
	}[];
	meta: Record<string, unknown>;
}

// Check metadata — embedded to avoid shelling out for explain
const CHECK_META: Record<string, { label: string; category: string; weight: number; description: string; risk: string; recommendation: string }> = {
	structure: { label: "Project Structure", category: "Foundations", weight: 6, description: "Checks for standard project files: package.json, tsconfig.json, LICENSE, README, .gitignore, lockfile. Verifies test-to-source ratio.", risk: "Missing config files cause build failures in CI. No lockfile means non-reproducible builds.", recommendation: "Ensure every project has package.json, tsconfig.json, LICENSE, .gitignore, and a lockfile." },
	lint: { label: "Lint", category: "Foundations", weight: 5, description: "Runs the project's linter (Biome or ESLint) and counts errors and warnings.", risk: "Unlinted code accumulates inconsistencies and latent bugs.", recommendation: "Fix all lint errors. Add Biome if no linter configured." },
	types: { label: "Type Check", category: "Foundations", weight: 6, description: "Runs tsc --noEmit to find TypeScript compilation errors.", risk: "Type errors are bugs — every unresolved error is a potential runtime crash.", recommendation: "Fix all type errors. Enable strict mode." },
	"type-safety": { label: "Type Safety", category: "Foundations", weight: 3, description: "Counts unsafe type patterns: 'as any', ': any', @ts-ignore, non-null assertions.", risk: "'as any' silences the type checker. Accumulated any usage correlates with higher defect density.", recommendation: "Replace 'as any' with proper types or type guards." },
	standards: { label: "Code Standards", category: "Foundations", weight: 3, description: "Checks naming conventions, file size, code smells (console.log, var, ==, eval).", risk: "Large files are hard to review. console.log in production leaks data.", recommendation: "Split files over 300 lines. Use const/let, ===, and safe DOM APIs." },
	complexity: { label: "Complexity", category: "Quality", weight: 5, description: "Measures cognitive complexity per function.", risk: "Complex functions are the #1 source of bugs.", recommendation: "Extract complex functions into smaller ones. Use early returns." },
	duplication: { label: "Duplication", category: "Quality", weight: 5, description: "Detects copy-pasted code blocks of 6+ lines.", risk: "Duplicated code means bugs must be fixed in multiple places.", recommendation: "Extract duplicated logic into shared functions." },
	"error-handling": { label: "Error Handling", category: "Quality", weight: 3, description: "Detects empty catch, throw string, floating promises, unsafe JSON.parse.", risk: "Empty catch blocks silently swallow errors.", recommendation: "Handle or log every catch. Use throw new Error()." },
	react: { label: "React Patterns", category: "Quality", weight: 3, description: "Checks conditional hooks, missing keys, index as key, prop spreading.", risk: "Conditional hooks crash React. Missing keys cause incorrect reconciliation.", recommendation: "Never call hooks inside conditions. Always provide stable keys." },
	accessibility: { label: "Accessibility", category: "Quality", weight: 4, description: "Checks img alt, click handlers without keyboard, unlabeled forms.", risk: "1 in 4 adults has a disability.", recommendation: "Add alt text. Use <button> for clickable elements." },
	docs: { label: "Documentation", category: "Quality", weight: 3, description: "Checks README quality and JSDoc coverage.", risk: "Undocumented code is hard to onboard to.", recommendation: "Write README with install/usage. Add JSDoc to public exports." },
	"best-practices": { label: "Best Practices", category: "Quality", weight: 3, description: "CI/CD, supply chain, OIDC, pinned actions, SECURITY.md, CODEOWNERS.", risk: "Missing CI practices lead to supply chain attacks.", recommendation: "Pin actions to SHA. Use OIDC. Add SECURITY.md." },
	testing: { label: "Testing", category: "Testing", weight: 15, description: "Test pyramid, execution, coverage, file pairing, quality metrics.", risk: "Code without tests is code you can't safely change.", recommendation: "Follow testing pyramid. Aim for >80% branch coverage." },
	secrets: { label: "Secrets", category: "Security", weight: 6, description: "Scans for hardcoded secrets: AWS, GitHub, Stripe, OpenAI keys. Delegates to gitleaks.", risk: "Hardcoded secrets are the #1 cause of credential leaks.", recommendation: "Use environment variables or a secret manager." },
	security: { label: "Security Patterns", category: "Security", weight: 5, description: "31 CWE patterns: XSS, injection, weak crypto, prototype pollution, path traversal.", risk: "These patterns represent OWASP Top 10 vulnerabilities.", recommendation: "Replace innerHTML with textContent. Never use eval(). Use parameterized queries." },
	dependencies: { label: "Dependencies", category: "Security", weight: 5, description: "npm audit for CVEs, outdated package detection.", risk: "Vulnerable dependencies are the most common supply chain attack vector.", recommendation: "Run audit regularly. Use Dependabot or Renovate." },
	architecture: { label: "Architecture", category: "Architecture", weight: 5, description: "Circular deps, god modules, orphans, fan-out, import graph analysis.", risk: "Circular deps make refactoring impossible. God modules become bottlenecks.", recommendation: "Break circular deps. Split god modules by concern." },
	performance: { label: "Performance", category: "Architecture", weight: 4, description: "Barrel imports, heavy deps, dynamic import opportunities, CSS-in-JS overhead.", risk: "Barrel files prevent tree-shaking, bloating bundles 2-10x.", recommendation: "Replace barrel re-exports with direct imports." },
	confusion: { label: "Confusion Index", category: "LLM Readiness", weight: 6, description: "Naming ambiguity that causes LLMs to misunderstand code.", risk: "LLMs drop 28.6% on code tasks when names are ambiguous.", recommendation: "Use descriptive, unique names. Avoid synonym files." },
	context: { label: "Context Locality", category: "LLM Readiness", weight: 5, description: "Token density, import depth, circular dep impact on LLM navigation.", risk: "Files over 4000 tokens exceed the LLM attention sweet spot.", recommendation: "Keep files under 400 lines. Limit imports to <15 per file." },
	"doc-coherence": { label: "Doc Coherence", category: "AI Analysis", weight: 0, description: "LLM-powered: stale README claims, incorrect JSDoc, outdated CHANGELOG.", risk: "Stale docs actively mislead developers and LLMs.", recommendation: "Pro feature — set VCQA_PRO_KEY." },
	"code-coherence": { label: "Code Coherence", category: "AI Analysis", weight: 0, description: "LLM-powered: inconsistent validation, conflicting defaults, naming drift.", risk: "Incoherent codebases cause 'works on my machine' bugs.", recommendation: "Pro feature — set VCQA_PRO_KEY." },
	"comment-staleness": { label: "Comment Staleness", category: "AI Analysis", weight: 0, description: "Stale TODOs, numeric mismatches, commented-out code, @deprecated without replacement.", risk: "Stale comments mislead developers and AI agents.", recommendation: "Delete old TODOs. Remove commented-out code." },
	"dead-patterns": { label: "Dead Patterns", category: "AI Analysis", weight: 0, description: "Leftover code from incomplete refactors: fallbacks, parallel impls, dead guards.", risk: "Vibe-coded projects accumulate dead patterns fast.", recommendation: "Pro feature — set VCQA_PRO_KEY." },
	"test-audit": { label: "Test Audit", category: "AI Analysis", weight: 0, description: "Fake/shallow tests: empty bodies, trivial assertions, mock abuse.", risk: "AI-generated tests often look real but test nothing.", recommendation: "Pro feature — set VCQA_PRO_KEY." },
};

// Cache scan results to avoid re-scanning on every tool call
let cachedReport: ScanReport | null = null;
let cachedCwd: string | null = null;
let cachedAt = 0;
const CACHE_TTL = 60_000; // 1 minute

function runScan(cwd: string): ScanReport {
	const now = Date.now();
	if (cachedReport && cachedCwd === cwd && now - cachedAt < CACHE_TTL) {
		return cachedReport;
	}

	// Try reading cached report.json first (from previous CLI run)
	const reportPath = join(cwd, ".vibe-check", "report.json");
	if (existsSync(reportPath)) {
		try {
			const stat = statSync(reportPath);
			if (now - stat.mtimeMs < 300_000) {
				const report = JSON.parse(readFileSync(reportPath, "utf-8")) as ScanReport;
				cachedReport = report;
				cachedCwd = cwd;
				cachedAt = now;
				return report;
			}
		} catch { /* fall through to live scan */ }
	}

	// Run live scan
	try {
		const stdout = execSync("npx @vibecodeqa/cli --skip-tests --json .", {
			cwd,
			encoding: "utf-8",
			timeout: 60_000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const report = JSON.parse(stdout) as ScanReport;
		cachedReport = report;
		cachedCwd = cwd;
		cachedAt = now;
		return report;
	} catch (err) {
		throw new Error(`vcqa scan failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

const server = new McpServer({
	name: "vcqa",
	version: "0.5.0",
});

// ── Tool: vcqa_score ──
server.tool(
	"vcqa_score",
	"Get the code health score and grade for the current project. Fast — uses cached results when available.",
	{ path: z.string().optional().describe("Project directory path (defaults to cwd)") },
	async ({ path }) => {
		const cwd = path || process.cwd();
		const report = runScan(cwd);
		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify({
					score: report.score,
					grade: report.grade,
					summary: `${report.grade} ${report.score}/100`,
					checks: report.checks.map(c => ({
						name: c.name,
						score: c.score,
						grade: c.grade,
						issues: c.issues.length,
					})),
				}, null, 2),
			}],
		};
	},
);

// ── Tool: vcqa_scan ──
server.tool(
	"vcqa_scan",
	"Run a full code health scan. Returns score, grade, and all 34 check results with issues. Use vcqa_score for a quicker summary.",
	{ path: z.string().optional().describe("Project directory path (defaults to cwd)") },
	async ({ path }) => {
		const cwd = path || process.cwd();
		const report = runScan(cwd);
		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify(report, null, 2),
			}],
		};
	},
);

// ── Tool: vcqa_file_health ──
server.tool(
	"vcqa_file_health",
	"Get all code health issues for a specific file. Use before modifying a file to understand existing problems, or after to check for new issues.",
	{
		file: z.string().describe("File path relative to project root (e.g., 'src/auth.ts')"),
		path: z.string().optional().describe("Project directory path (defaults to cwd)"),
	},
	async ({ file, path }) => {
		const cwd = path || process.cwd();
		const report = runScan(cwd);
		const fileIssues: { check: string; severity: string; message: string; line?: number; rule?: string }[] = [];
		for (const c of report.checks) {
			for (const i of c.issues) {
				if (i.file && (i.file === file || i.file.endsWith(`/${file}`) || file.endsWith(i.file))) {
					fileIssues.push({ check: c.name, severity: i.severity, message: i.message, line: i.line, rule: i.rule });
				}
			}
		}
		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify({
					file,
					issues: fileIssues.length,
					details: fileIssues,
					advice: fileIssues.length === 0
						? "No issues found for this file."
						: `${fileIssues.length} issues found. Fix errors first, then warnings.`,
				}, null, 2),
			}],
		};
	},
);

// ── Tool: vcqa_check ──
server.tool(
	"vcqa_check",
	"Get detailed results for a specific check (e.g., 'complexity', 'security', 'testing'). Shows score, issues, and metadata.",
	{
		check: z.string().describe("Check name (e.g., 'complexity', 'security', 'testing', 'architecture')"),
		path: z.string().optional().describe("Project directory path (defaults to cwd)"),
	},
	async ({ check, path }) => {
		const cwd = path || process.cwd();
		const report = runScan(cwd);
		const c = report.checks.find(ch => ch.name === check);
		if (!c) {
			return {
				content: [{
					type: "text" as const,
					text: JSON.stringify({ error: `Unknown check: ${check}`, available: report.checks.map(ch => ch.name) }, null, 2),
				}],
			};
		}
		const meta = CHECK_META[check];
		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify({
					name: c.name,
					label: meta?.label || c.name,
					score: c.score,
					grade: c.grade,
					category: meta?.category,
					weight: meta ? `${meta.weight}%` : undefined,
					details: c.details,
					issues: c.issues,
					recommendation: meta?.recommendation,
				}, null, 2),
			}],
		};
	},
);

// ── Tool: vcqa_explain ──
server.tool(
	"vcqa_explain",
	"Explain what a specific check measures, why it matters, and how to fix issues. Use to understand WHY a check is flagging something.",
	{
		check: z.string().describe("Check name to explain (e.g., 'confusion', 'context', 'architecture')"),
	},
	async ({ check }) => {
		const meta = CHECK_META[check];
		if (!meta) {
			return {
				content: [{
					type: "text" as const,
					text: JSON.stringify({ error: `Unknown check: ${check}`, available: Object.keys(CHECK_META) }, null, 2),
				}],
			};
		}
		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify({
					name: check,
					label: meta.label,
					category: meta.category,
					weight: `${meta.weight}%`,
					what: meta.description,
					risk: meta.risk,
					fix: meta.recommendation,
				}, null, 2),
			}],
		};
	},
);

// ── Tool: vcqa_fix ──
server.tool(
	"vcqa_fix",
	"AI-powered fix for code quality issues. Scans the project, identifies fixable issues, and uses Claude to generate and apply fixes. Requires ANTHROPIC_API_KEY env var.",
	{
		path: z.string().optional().describe("Project directory path (defaults to cwd)"),
		check: z.string().optional().describe("Only fix issues from a specific check (e.g., 'security')"),
		dryRun: z.boolean().optional().describe("Preview fixes without applying (default: false)"),
	},
	async ({ path, check, dryRun }) => {
		const cwd = path || process.cwd();
		const flags = ["fix", "--ai"];
		if (check) flags.push("--check", check);
		if (dryRun) flags.push("--dry-run");
		flags.push(cwd);

		try {
			const stdout = execSync(`npx @vibecodeqa/cli ${flags.join(" ")}`, {
				cwd,
				encoding: "utf-8",
				timeout: 120_000,
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env },
			});
			// Invalidate cache after fix
			cachedReport = null;
			return {
				content: [{
					type: "text" as const,
					text: stdout.replace(/\x1b\[[0-9;]*m/g, ""), // strip ANSI
				}],
			};
		} catch (err: any) {
			const output = err.stdout || err.stderr || String(err);
			return {
				content: [{
					type: "text" as const,
					text: output.replace(/\x1b\[[0-9;]*m/g, ""),
				}],
			};
		}
	},
);

// ── Tool: vcqa_delta ──
server.tool(
	"vcqa_delta",
	"Compare current scan against previous scan. Shows what changed: score delta, fixed issues, new issues, per-check changes. Useful after making fixes to see impact.",
	{
		path: z.string().optional().describe("Project directory path (defaults to cwd)"),
	},
	async ({ path }) => {
		const cwd = path || process.cwd();
		const reportPath = join(cwd, ".vibe-check", "report.json");

		// Load previous report
		let prevReport: ScanReport | null = null;
		if (existsSync(reportPath)) {
			try { prevReport = JSON.parse(readFileSync(reportPath, "utf-8")) as ScanReport; } catch { /* corrupt */ }
		}

		if (!prevReport) {
			return { content: [{ type: "text" as const, text: "No previous report found. Run vcqa_scan first to establish a baseline, then make changes and run vcqa_delta." }] };
		}

		// Run fresh scan (invalidate cache to get live results)
		cachedReport = null;
		const currentReport = runScan(cwd);

		// Compute delta (issue-level diffing)
		const beforeIssues = new Map<string, number>();
		const afterIssues = new Map<string, number>();

		for (const c of prevReport.checks) {
			for (const iss of c.issues) {
				const key = `${c.name}|${iss.rule || ""}|${iss.file || ""}|${iss.message}`;
				beforeIssues.set(key, (beforeIssues.get(key) || 0) + 1);
			}
		}
		for (const c of currentReport.checks) {
			for (const iss of c.issues) {
				const key = `${c.name}|${iss.rule || ""}|${iss.file || ""}|${iss.message}`;
				afterIssues.set(key, (afterIssues.get(key) || 0) + 1);
			}
		}

		let fixedCount = 0;
		let newCount = 0;
		const fixedSamples: string[] = [];
		const newSamples: string[] = [];

		for (const [key, bCount] of beforeIssues) {
			const aCount = afterIssues.get(key) || 0;
			if (bCount > aCount) {
				fixedCount += bCount - aCount;
				if (fixedSamples.length < 5) fixedSamples.push(key.split("|").slice(0, 2).join(": "));
			}
		}
		for (const [key, aCount] of afterIssues) {
			const bCount = beforeIssues.get(key) || 0;
			if (aCount > bCount) {
				newCount += aCount - bCount;
				if (newSamples.length < 5) newSamples.push(key.split("|").slice(0, 2).join(": "));
			}
		}

		const scoreDelta = currentReport.score - prevReport.score;
		const checkChanges = currentReport.checks
			.map((c: ScanReport["checks"][0]) => {
				const prev = prevReport!.checks.find((p: ScanReport["checks"][0]) => p.name === c.name);
				return { name: c.name, before: prev?.score ?? 0, after: c.score, delta: c.score - (prev?.score ?? 0) };
			})
			.filter((c: { delta: number }) => c.delta !== 0)
			.sort((a: { delta: number }, b: { delta: number }) => b.delta - a.delta);

		let text = `Score: ${prevReport.grade} ${prevReport.score} → ${currentReport.grade} ${currentReport.score} (${scoreDelta > 0 ? "+" : ""}${scoreDelta})\n`;
		text += `Fixed: ${fixedCount} issues | New: ${newCount} issues\n\n`;

		if (checkChanges.length > 0) {
			text += "Check changes:\n";
			for (const c of checkChanges.slice(0, 10)) {
				text += `  ${c.delta > 0 ? "+" : ""}${c.delta} ${c.name} (${c.before} → ${c.after})\n`;
			}
			text += "\n";
		}
		if (fixedSamples.length > 0) text += `Fixed examples: ${fixedSamples.join(", ")}\n`;
		if (newSamples.length > 0) text += `New examples: ${newSamples.join(", ")}\n`;

		return { content: [{ type: "text" as const, text }] };
	},
);

// ── Code-access tools (let an agent read the SAME source the monitor shows) ──

const IGNORE_DIRS = new Set([
	"node_modules", ".git", "dist", "build", ".next", "out", "coverage",
	".vibe-check", ".turbo", ".wrangler", ".cache", "target", ".svelte-kit", "vendor",
]);
const SOURCE_EXTS = new Set([
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
	".py", ".go", ".rs", ".java", ".rb", ".php", ".cs", ".css", ".scss",
	".json", ".md", ".yml", ".yaml", ".prisma", ".sql",
]);

/** Walk a project's files, skipping the usual build/vendor dirs. */
function walkFiles(root: string, opts: { exts?: Set<string>; max?: number } = {}): string[] {
	const out: string[] = [];
	const max = opts.max ?? 10_000;
	const stack: string[] = [root];
	while (stack.length && out.length < max) {
		const dir = stack.pop() as string;
		let entries: import("node:fs").Dirent[];
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
		for (const e of entries) {
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (!IGNORE_DIRS.has(e.name)) stack.push(full);
			} else if (e.isFile()) {
				if (!opts.exts || opts.exts.has(extname(e.name))) out.push(full);
			}
		}
	}
	return out;
}

/** Resolve `rel` under `root`, refusing paths that escape the project. */
function safeResolve(root: string, rel: string): string {
	const base = resolve(root);
	const abs = resolve(base, rel);
	if (abs !== base && !abs.startsWith(base + "/")) {
		throw new Error(`path escapes project root: ${rel}`);
	}
	return abs;
}

// ── Tool: vcqa_read_file ──
server.tool(
	"vcqa_read_file",
	"Read a source file from the project — the exact code the VibeCode monitor shows. Returns contents with line numbers so you can cite precise lines.",
	{
		file: z.string().describe("File path relative to project root, e.g. 'src/app.ts'"),
		path: z.string().optional().describe("Project directory (defaults to cwd)"),
		max_lines: z.number().optional().describe("Cap lines returned (default 800)"),
	},
	async ({ file, path, max_lines }) => {
		const cwd = path || process.cwd();
		let abs: string;
		try { abs = safeResolve(cwd, file); } catch (e) { return { content: [{ type: "text" as const, text: String(e) }], isError: true }; }
		if (!existsSync(abs)) return { content: [{ type: "text" as const, text: `Not found: ${file}` }], isError: true };
		const lines = readFileSync(abs, "utf-8").split("\n");
		const cap = max_lines ?? 800;
		const numbered = lines.slice(0, cap).map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join("\n");
		const more = lines.length > cap ? `\n… (${lines.length - cap} more lines truncated)` : "";
		return { content: [{ type: "text" as const, text: numbered + more }] };
	},
);

// ── Tool: vcqa_list_files ──
server.tool(
	"vcqa_list_files",
	"List the project's files (skipping node_modules/dist/.git etc.) — the inventory behind the monitor's Files view. Optionally filter by extension or a path substring.",
	{
		path: z.string().optional().describe("Project directory (defaults to cwd)"),
		ext: z.string().optional().describe("Filter to an extension, e.g. 'ts' or '.tsx'"),
		contains: z.string().optional().describe("Only paths containing this substring"),
		limit: z.number().optional().describe("Max files to return (default 500)"),
	},
	async ({ path, ext, contains, limit }) => {
		const cwd = resolve(path || process.cwd());
		const exts = ext ? new Set([ext.startsWith(".") ? ext : `.${ext}`]) : undefined;
		let files = walkFiles(cwd, { exts }).map((f) => relative(cwd, f));
		if (contains) files = files.filter((f) => f.includes(contains));
		const total = files.length;
		files = files.sort().slice(0, limit ?? 500);
		return { content: [{ type: "text" as const, text: JSON.stringify({ root: cwd, total, shown: files.length, files }, null, 2) }] };
	},
);

// ── Tool: vcqa_grep ──
server.tool(
	"vcqa_grep",
	"Search the project's source files for a regular expression. Returns matching 'file:line: text' — use to find where something is defined or used.",
	{
		pattern: z.string().describe("Regular expression to search for"),
		path: z.string().optional().describe("Project directory (defaults to cwd)"),
		ext: z.string().optional().describe("Restrict to an extension, e.g. 'ts'"),
		max_matches: z.number().optional().describe("Cap total matches (default 200)"),
	},
	async ({ pattern, path, ext, max_matches }) => {
		const cwd = resolve(path || process.cwd());
		let re: RegExp;
		try { re = new RegExp(pattern); } catch (e) { return { content: [{ type: "text" as const, text: `bad regex: ${String(e)}` }], isError: true }; }
		const exts = ext ? new Set([ext.startsWith(".") ? ext : `.${ext}`]) : SOURCE_EXTS;
		const cap = max_matches ?? 200;
		const hits: string[] = [];
		for (const f of walkFiles(cwd, { exts })) {
			if (hits.length >= cap) break;
			let content: string;
			try { if (statSync(f).size > 2_000_000) continue; content = readFileSync(f, "utf-8"); } catch { continue; }
			const lines = content.split("\n");
			for (let i = 0; i < lines.length; i++) {
				if (re.test(lines[i])) {
					hits.push(`${relative(cwd, f)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
					if (hits.length >= cap) break;
				}
			}
		}
		return { content: [{ type: "text" as const, text: hits.length ? hits.join("\n") : "no matches" }] };
	},
);

// ── Tool: vcqa_graph (dependency graph — the Graph view's nodes/edges) ──

const CODE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const IMPORT_RE =
	/(?:import|export)[^'"`]*?from\s*['"]([^'"]+)['"]|(?:^|[^.\w])import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Resolve a relative import spec to an on-disk file (trying extensions + /index). */
function resolveLocal(fromFile: string, spec: string): string | null {
	const baseAbs = resolve(dirname(fromFile), spec);
	const tries = [baseAbs, ...CODE_EXTS.map((e) => baseAbs + e), ...CODE_EXTS.map((e) => join(baseAbs, "index" + e))];
	for (const t of tries) { try { if (statSync(t).isFile()) return t; } catch { /* next */ } }
	return null;
}

function libName(spec: string): string {
	if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
	return spec.split("/")[0];
}

/** Test/spec file by the conventions shared with the monitor's structural views:
 *  a `.test.`/`.spec.` (or `_test.`) filename, or a path segment like `__tests__`,
 *  `__mocks__`, `tests`, `test`, `e2e`. Tests are a separate class and are excluded
 *  from the graph by default — they live in the Tests view, not the structure. */
function isTestFile(rel: string): boolean {
	const p = rel.replace(/\\/g, "/").toLowerCase();
	const base = p.split("/").pop() || p;
	if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base) || /_test\.[a-z0-9]+$/.test(base)) return true;
	return p.split("/").some((seg) => seg === "__tests__" || seg === "__mocks__" || seg === "tests" || seg === "test" || seg === "e2e");
}

function buildImportGraph(root: string, includeTests = false) {
	const files = walkFiles(root, { exts: new Set(CODE_EXTS) });
	const nodes = new Map<string, { id: string; label: string; type: string; indeg: number; outdeg: number }>();
	const edges: { from: string; to: string }[] = [];
	const nodeFor = (id: string, label: string, type: string) => {
		if (!nodes.has(id)) nodes.set(id, { id, label, type, indeg: 0, outdeg: 0 });
		return nodes.get(id) as { id: string; label: string; type: string; indeg: number; outdeg: number };
	};
	for (const abs of files) {
		const rel = relative(root, abs);
		const type = /\.(tsx|jsx)$/.test(abs) ? "ui" : "module";
		const src = nodeFor(rel, rel.split("/").pop() || rel, type);
		let content: string;
		try { if (statSync(abs).size > 2_000_000) continue; content = readFileSync(abs, "utf-8"); } catch { continue; }
		const seen = new Set<string>();
		for (const m of content.matchAll(IMPORT_RE)) {
			const spec = m[1] || m[2] || m[3] || m[4];
			if (!spec || seen.has(spec)) continue;
			seen.add(spec);
			let toId: string;
			if (spec.startsWith(".") || spec.startsWith("/")) {
				const target = resolveLocal(abs, spec);
				if (!target) continue;
				const trel = relative(root, target);
				nodeFor(trel, trel.split("/").pop() || trel, /\.(tsx|jsx)$/.test(target) ? "ui" : "module");
				toId = trel;
			} else {
				const name = libName(spec);
				nodeFor(`lib:${name}`, name, "lib");
				toId = `lib:${name}`;
			}
			edges.push({ from: rel, to: toId });
			src.outdeg++;
			(nodes.get(toId) as { indeg: number }).indeg++;
		}
	}
	let list = [...nodes.values()];
	let outEdges = edges;
	if (!includeTests) {
		// Remove test nodes + their edges entirely (not just flag them), matching
		// the Graph view, then recompute degrees on the trimmed edge set.
		const drop = new Set(list.filter((n) => n.type !== "lib" && isTestFile(n.id)).map((n) => n.id));
		if (drop.size) {
			list = list.filter((n) => !drop.has(n.id));
			outEdges = edges.filter((e) => !drop.has(e.from) && !drop.has(e.to));
			for (const n of list) { n.indeg = 0; n.outdeg = 0; }
			const byId = new Map(list.map((n) => [n.id, n]));
			for (const e of outEdges) {
				const f = byId.get(e.from); if (f) f.outdeg++;
				const t = byId.get(e.to); if (t) t.indeg++;
			}
		}
	}
	return { nodes: list, edges: outEdges };
}

server.tool(
	"vcqa_graph",
	"Get the project's module dependency graph — the nodes and edges the monitor's Graph view draws. Nodes are files (type module|ui) and external libs (type lib); edges are imports. Use to see who imports/depends on a file. Test/spec files are excluded by default (they live in the Tests view, not the structure) — pass include_tests to add them.",
	{
		path: z.string().optional().describe("Project directory (defaults to cwd)"),
		include_tests: z.boolean().optional().describe("Include *.test/*.spec and test-folder files as nodes (default false, matching the Graph view)"),
	},
	async ({ path, include_tests }) => {
		const cwd = resolve(path || process.cwd());
		const g = buildImportGraph(cwd, include_tests ?? false);
		const byType: Record<string, number> = {};
		for (const n of g.nodes) byType[n.type] = (byType[n.type] || 0) + 1;
		const mostConnected = [...g.nodes]
			.filter((n) => n.type !== "lib")
			.sort((a, b) => b.indeg + b.outdeg - (a.indeg + a.outdeg))
			.slice(0, 10)
			.map((n) => ({ id: n.id, in: n.indeg, out: n.outdeg }));
		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify({ summary: { nodes: g.nodes.length, edges: g.edges.length, byType }, mostConnected, nodes: g.nodes, edges: g.edges }, null, 2),
			}],
		};
	},
);

// ── Tool: vcqa_architecture (React layers — the Architecture view) ──
// Builds a real call graph with graphify (local, no-LLM) and reshapes it into the
// same layered model the monitor's Architecture view draws: symbols bucketed into
// Routes → Components → Hooks → State → Services → Lib → Data, plus the call/import
// flow between layers. graphify must be installed (`uv tool install graphifyy`).

/** Locate the graphify binary (PATH via `command -v`, then the uv-tool default
 *  ~/.local/bin). The `command -v graphify` argument is a fixed string — no user
 *  input — so the shell here is safe. */
function findGraphify(): string | null {
	try { return execSync("command -v graphify", { encoding: "utf-8" }).trim() || null; }
	catch { /* not on PATH */ }
	const local = join(homedir(), ".local", "bin", "graphify");
	return existsSync(local) ? local : null;
}

/** Run graphify on a project and return its extraction graph, or an error string.
 *  Uses execFileSync (no shell) so a project path with spaces or shell
 *  metacharacters can't be misinterpreted or injected. */
function loadGraphifyGraph(cwd: string): { graph?: GraphifyGraph; error?: string } {
	const bin = findGraphify();
	if (!bin) return { error: "graphify not installed. Install it with: uv tool install graphifyy" };
	if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return { error: `Not a directory: ${cwd}` };
	try {
		execFileSync(bin, ["update", cwd, "--no-cluster"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
	} catch (e) { return { error: `graphify failed: ${(e as Error).message}` }; }
	const graphPath = join(cwd, "graphify-out", "graph.json");
	if (!existsSync(graphPath)) return { error: "graphify produced no graph.json" };
	let parsed: unknown;
	try { parsed = JSON.parse(readFileSync(graphPath, "utf-8")); }
	catch (e) { return { error: `unreadable graph.json: ${(e as Error).message}` }; }
	if (!parsed || typeof parsed !== "object") return { error: "graph.json was not a graph object" };
	const g = parsed as Partial<GraphifyGraph>;
	// Tolerate graphify schema drift: coerce to arrays so downstream never throws.
	// Strip nodes under hidden/tooling dirs (.claude, .vscode, .github, …) so the
	// architecture/callflow/sequence tools describe application source only.
	return { graph: stripHiddenNodes({ nodes: Array.isArray(g.nodes) ? g.nodes : [], links: Array.isArray(g.links) ? g.links : [] }) };
}

server.tool(
	"vcqa_architecture",
	"Map the project's React architecture into layers (Routes/Pages, Components, Hooks, State/Context, Services/API, Lib/Utils, Data/DB) plus the call/import flow between layers — the same model the monitor's Architecture view shows. Symbols are classified by kind (component/hook/service/type…) from a real call graph built locally by graphify. Use to understand what layers exist, which hooks/services are defined, and how they call each other. Requires graphify (`uv tool install graphifyy`).",
	{
		path: z.string().optional().describe("Project directory (defaults to cwd)"),
	},
	async ({ path }) => {
		const cwd = resolve(path || process.cwd());
		const { graph, error } = loadGraphifyGraph(cwd);
		if (error) return { content: [{ type: "text" as const, text: JSON.stringify({ error }) }], isError: true };

		const model = buildArchitecture(graph);
		// A compact projection: layer sizes + member names + the flow list, so the
		// agent gets the shape without the full node payload.
		const layers = model.layers.map((l) => ({
			id: l.id, label: l.label, count: l.nodes.length,
			members: l.nodes.map((n) => ({ name: n.name, kind: n.kind })),
		}));
		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify({ stats: model.stats, layers, flows: model.flows }, null, 2),
			}],
		};
	},
);

// ── Tool: vcqa_callflow (real function-call tree — the Flow view) ──
// Traces how calls actually flow through the code: pick an entry symbol and see
// its downstream call tree (graphify `calls` edges, function-level). With no root,
// lists the entry points (symbols nothing calls / components/hooks) ranked by reach.

server.tool(
	"vcqa_callflow",
	"Trace how function calls actually flow through the project — the monitor's Flow view. With no `root`, returns the entry points (symbols nothing calls, or components/hooks) ranked by how many symbols they reach. With a `root` (a function/component/hook name or id), returns its downstream call tree: each reached symbol with its call depth, plus the caller→callee edges. Use to answer 'what does X actually call?' and to see execution paths through the layers. Requires graphify (`uv tool install graphifyy`).",
	{
		path: z.string().optional().describe("Project directory (defaults to cwd)"),
		root: z.string().optional().describe("Entry symbol to trace from (function/component/hook name or id). Omit to list entry points."),
		max_depth: z.number().optional().describe("Max call depth to follow when tracing (default 6)"),
	},
	async ({ path, root, max_depth }) => {
		const cwd = resolve(path || process.cwd());
		const { graph, error } = loadGraphifyGraph(cwd);
		if (error) return { content: [{ type: "text" as const, text: JSON.stringify({ error }) }], isError: true };

		const cg = buildCallGraph(graph);
		if (!root) {
			const eps = entryPoints(cg).slice(0, 40).map((e) => ({ name: e.name, kind: e.kind, layer: e.layer, reach: e.reach, file: e.file }));
			return { content: [{ type: "text" as const, text: JSON.stringify({ entryPoints: eps, note: "Pass root=<name> to trace a symbol's downstream call tree." }, null, 2) }] };
		}
		const matches = resolveRootMatches(cg, root);
		if (matches.length === 0) {
			const suggest = entryPoints(cg).slice(0, 8).map((e) => e.name);
			return { content: [{ type: "text" as const, text: JSON.stringify({ error: `No callable symbol named "${root}". Try one of: ${suggest.join(", ")}` }) }], isError: true };
		}
		const rootId = matches[0];
		const trace = traceFrom(cg, rootId, { maxDepth: max_depth ?? 6 });
		const byId = new Map(trace.nodes.map((n) => [n.id, n.name]));
		// If a plain name matched several symbols, say so and surface the alternatives
		// (by file) so the caller can re-query with the exact one they meant.
		const ambiguous = matches.length > 1
			? matches.map((id) => ({ id, name: cg.nodes.get(id)!.name, file: cg.nodes.get(id)!.file }))
			: undefined;
		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify({
					root: cg.nodes.get(rootId)!.name,
					...(ambiguous ? { ambiguous } : {}),
					truncated: trace.truncated,
					symbols: trace.nodes.map((n) => ({ name: n.name, kind: n.kind, layer: n.layer, depth: n.depth, file: n.file })),
					calls: trace.edges.map((e) => ({ from: byId.get(e.from), to: byId.get(e.to) })),
				}, null, 2),
			}],
		};
	},
);

// ── Tool: vcqa_sequence (static sequence approximation — the Sequence view) ──
// Linearizes a symbol's call tree into execution order (DFS pre-order) and returns
// it as a Mermaid sequenceDiagram plus the ordered steps. Static — no branch/loop/
// await semantics — but reads like a sequence of who-calls-whom.

server.tool(
	"vcqa_sequence",
	"Approximate a sequence diagram for a symbol: trace its calls in execution order (DFS pre-order — each call fully expanded before the next) and return a Mermaid `sequenceDiagram` plus the ordered steps. This is a STATIC approximation (no branches/loops/await), but shows the who-calls-whom order through the code. Requires a `root` symbol (function/component/hook name or id) and graphify (`uv tool install graphifyy`).",
	{
		path: z.string().optional().describe("Project directory (defaults to cwd)"),
		root: z.string().describe("Entry symbol to sequence from (function/component/hook name or id)"),
		max_depth: z.number().optional().describe("Max call depth to follow (default 6)"),
	},
	async ({ path, root, max_depth }) => {
		const cwd = resolve(path || process.cwd());
		const { graph, error } = loadGraphifyGraph(cwd);
		if (error) return { content: [{ type: "text" as const, text: JSON.stringify({ error }) }], isError: true };

		const cg = buildCallGraph(graph);
		const matches = resolveRootMatches(cg, root);
		if (matches.length === 0) {
			const suggest = entryPoints(cg).slice(0, 8).map((e) => e.name);
			return { content: [{ type: "text" as const, text: JSON.stringify({ error: `No callable symbol named "${root}". Try one of: ${suggest.join(", ")}` }) }], isError: true };
		}
		const rootId = matches[0];
		const ambiguous = matches.length > 1
			? matches.map((id) => ({ id, name: cg.nodes.get(id)!.name, file: cg.nodes.get(id)!.file }))
			: undefined;
		const seq = buildSequence(cg, rootId, { maxDepth: max_depth ?? 6 });
		const nameOf = new Map(seq.participants.map((p) => [p.id, p.name]));
		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify({
					root: seq.root,
					...(ambiguous ? { ambiguous } : {}),
					truncated: seq.truncated,
					participants: seq.participants.map((p) => ({ name: p.name, kind: p.kind, layer: p.layer })),
					steps: seq.steps.map((s) => ({ from: nameOf.get(s.from), to: nameOf.get(s.to), depth: s.depth })),
					mermaid: toMermaid(seq),
				}, null, 2),
			}],
		};
	},
);

// ── Live app state: read the running monitor's localStorage (macOS/dev) ──
// The desktop app persists its UI state and each page's copilot thread in the
// WKWebView localStorage. Exposing it here gives an external agent the SAME view
// the user is looking at — current folder/page and the copilot conversation —
// entirely through MCP (no reaching around into the app's private store).

let cachedStore: string | null = null;
/** Find the monitor's localStorage sqlite (the one holding vcqa keys). */
function findMonitorStore(): string | null {
	if (cachedStore && existsSync(cachedStore)) return cachedStore;
	try {
		const base = join(homedir(), "Library", "WebKit");
		if (!existsSync(base)) return null;
		const found = execSync(`find "${base}" -name localstorage.sqlite3 -type f 2>/dev/null`, { encoding: "utf-8" }).trim();
		for (const db of found.split("\n").filter(Boolean)) {
			try {
				const keys = execSync(`sqlite3 "${db}" "SELECT key FROM ItemTable LIMIT 300;" 2>/dev/null`, { encoding: "utf-8" });
				if (keys.includes("vcqa:monitor") || keys.includes("vibe-monitor.copilot")) { cachedStore = db; return db; }
			} catch { /* locked / unreadable — try next */ }
		}
	} catch { /* find / sqlite3 unavailable */ }
	return null;
}

/** Read one localStorage value (WebKit stores them as UTF-16LE blobs). Copies the
 *  db first so a live write in the running app can't lock or tear the read. */
function readStoreValue(db: string, key: string): string | null {
	const tmp = join(tmpdir(), `vcqa-ls-${process.pid}.sqlite3`);
	try {
		execSync(`cp "${db}" "${tmp}" 2>/dev/null; for x in wal shm; do [ -f "${db}-$x" ] && cp "${db}-$x" "${tmp}-$x" 2>/dev/null; done; true`);
		const hex = execSync(`sqlite3 "${tmp}" "SELECT hex(value) FROM ItemTable WHERE key='${key.replace(/'/g, "''")}';" 2>/dev/null`, { encoding: "utf-8" }).trim();
		if (!hex) return null;
		const buf = Buffer.from(hex, "hex");
		let s = buf.toString("utf16le");
		if (s.includes("�")) { const u8 = buf.toString("utf8"); if (!u8.includes("�")) s = u8; }
		return s;
	} catch { return null; } finally {
		try { execSync(`rm -f "${tmp}" "${tmp}-wal" "${tmp}-shm"`); } catch { /* ignore */ }
	}
}

const VIEW_LABELS: Record<string, string> = {
	overview: "Health", files: "Files", canopy: "Graph", complexity: "Complexity",
	"duplicate-files": "Duplicate Files", "duplicate-code": "Duplicate Code",
	clones: "Duplicate Code", types: "Types", schema: "Schema", lint: "Lint",
	security: "Security", deps: "Deps", tests: "Tests", trends: "Trends",
	activity: "Activity", settings: "Settings",
};

// ── Tool: vcqa_app_state ──
server.tool(
	"vcqa_app_state",
	"Read the running VibeCode Monitor's live UI state — which project folder and which page (view) the user is currently looking at, and whether the copilot panel is open. This is what's on the user's screen right now.",
	{},
	async () => {
		const db = findMonitorStore();
		if (!db) return { content: [{ type: "text" as const, text: "Monitor localStorage not found (app not running, or unsupported platform)." }], isError: true };
		const raw = (k: string) => readStoreValue(db, k);
		const unq = (v: string | null) => (v ? v.replace(/^"|"$/g, "") : null);
		const view = unq(raw("vcqa:monitor:view"));
		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify({
					folder: unq(raw("vcqa:monitor:folder")),
					view,
					page: view ? VIEW_LABELS[view] ?? view : null,
					copilotOpen: raw("vcqa:monitor:copilot-open") === "true" || raw("vcqa:monitor:copilot-open") === "1",
				}, null, 2),
			}],
		};
	},
);

// ── Tool: vcqa_copilot_thread ──
server.tool(
	"vcqa_copilot_thread",
	"Read the in-app copilot's conversation for a page — the exact messages the user and the desktop copilot exchanged, including which tools it ran. Use to see what the copilot said/saw. Omit `page` to get every page's thread.",
	{ page: z.string().optional().describe("Page id, e.g. 'canopy' (Graph), 'schema', 'complexity'. Omit for all pages.") },
	async ({ page }) => {
		const db = findMonitorStore();
		if (!db) return { content: [{ type: "text" as const, text: "Monitor localStorage not found (app not running, or unsupported platform)." }], isError: true };
		const rawVal = readStoreValue(db, "vibe-monitor.copilot.threads.v1");
		if (!rawVal) return { content: [{ type: "text" as const, text: "No copilot threads yet." }] };
		let all: Record<string, { role: string; text?: string; toolCalls?: { name?: string }[] }[]>;
		try { all = JSON.parse(rawVal); } catch { return { content: [{ type: "text" as const, text: "Could not parse copilot threads." }], isError: true }; }
		const pick = page ? { [page]: all[page] ?? [] } : all;
		const out: Record<string, unknown[]> = {};
		for (const [pg, msgs] of Object.entries(pick)) {
			out[pg] = (msgs || []).map((m) => ({
				role: m.role,
				...(m.text ? { text: m.text } : {}),
				...(m.toolCalls?.length ? { tools: m.toolCalls.map((t) => t.name) } : {}),
			}));
		}
		return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
	},
);

// ── Tool: vcqa_copilot_send (text a page's copilot on the user's behalf) ──
server.tool(
	"vcqa_copilot_send",
	"Send a message to the running monitor's in-app copilot on a given page — as if the user typed it — and return the copilot's reply. The exchange also appears in the app UI. Requires the desktop monitor to be running. Write actions (issues/notes) never fire on a sent message.",
	{
		text: z.string().describe("The message to send to the copilot"),
		page: z.string().optional().describe("Page id: 'canopy' (Graph), 'schema', 'complexity', 'overview' (default), …"),
		timeout_s: z.number().optional().describe("How long to wait for the reply (default 90s)"),
	},
	async ({ text, page, timeout_s }) => {
		const dir = join(homedir(), ".vibe-monitor", "copilot-bridge");
		const reqDir = join(dir, "req");
		const resDir = join(dir, "res");
		mkdirSync(reqDir, { recursive: true });
		mkdirSync(resDir, { recursive: true });
		const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const reqPath = join(reqDir, `${id}.json`);
		const resPath = join(resDir, `${id}.json`);
		writeFileSync(reqPath, JSON.stringify({ id, page: page || "overview", text }));
		const deadline = Date.now() + (timeout_s ?? 90) * 1000;
		while (Date.now() < deadline) {
			if (existsSync(resPath)) {
				let reply = "";
				try { reply = JSON.parse(readFileSync(resPath, "utf-8")).text ?? ""; } catch { /* keep empty */ }
				try { unlinkSync(resPath); } catch { /* ignore */ }
				return { content: [{ type: "text" as const, text: reply || "(empty reply)" }] };
			}
			await new Promise((r) => setTimeout(r, 500));
		}
		try { unlinkSync(reqPath); } catch { /* ignore */ }
		return { content: [{ type: "text" as const, text: "Timed out waiting for the copilot — is the VibeCode Monitor running? (It polls every ~1.5s.)" }], isError: true };
	},
);

// ── Start server ──
async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((err) => {
	console.error("vcqa-mcp error:", err);
	process.exit(1);
});
