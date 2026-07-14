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
 *
 * Usage:
 *   npx @vibecodeqa/mcp                  # stdio transport (for Claude Code, Cursor, etc.)
 *   Add to claude_desktop_config.json:
 *   { "mcpServers": { "vcqa": { "command": "npx", "args": ["@vibecodeqa/mcp"] } } }
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
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
	version: "0.3.0",
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

// ── Start server ──
async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((err) => {
	console.error("vcqa-mcp error:", err);
	process.exit(1);
});
