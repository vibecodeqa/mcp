#!/usr/bin/env node
/**
 * VibeCode QA MCP Server
 *
 * Gives AI coding agents real-time code health context.
 * Tools:
 *   vcqa_scan        — Run a full scan, get score + grade + all check results
 *   vcqa_file_health — Get issues for a specific file
 *   vcqa_check       — Get details for a specific check (e.g., "complexity")
 *   vcqa_score       — Quick score + grade (fastest)
 *   vcqa_explain     — Explain what a check measures and how to fix it
 *
 * Usage:
 *   npx @vibecodeqa/mcp                  # stdio transport (for Claude Code, Cursor, etc.)
 *   Add to claude_desktop_config.json:
 *   { "mcpServers": { "vcqa": { "command": "npx", "args": ["@vibecodeqa/mcp"] } } }
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

interface ScanReport {
	score: number;
	grade: string;
	checks: { name: string; score: number; grade: string; details: Record<string, unknown>; issues: { severity: string; message: string; file?: string; line?: number; rule?: string }[] }[];
	meta: Record<string, unknown>;
}

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
			const stat = require("node:fs").statSync(reportPath);
			// Use cached report if less than 5 minutes old
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
			timeout: 30_000,
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

// Load check metadata from the CLI package
function getCheckMeta(checkName: string): { label: string; description: string; risk: string; recommendation: string; weight: number; category: string } {
	try {
		const stdout = execSync(`npx @vibecodeqa/cli explain ${checkName} 2>/dev/null`, {
			encoding: "utf-8",
			timeout: 10_000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		// Parse the explain output
		const label = stdout.match(/\x1b\[38;5;141m(.*?)\x1b/)?.[1] || checkName;
		const what = stdout.match(/What:\x1b\[0m (.*)/)?.[1] || "";
		const risk = stdout.match(/Risk:\x1b\[0m (.*)/)?.[1] || "";
		const fix = stdout.match(/Fix:\x1b\[0m (.*)/)?.[1] || "";
		const meta = stdout.match(/(\w+) priority · (\d+)% weight/);
		return {
			label,
			description: what,
			risk,
			recommendation: fix,
			weight: meta ? parseInt(meta[2], 10) : 5,
			category: "",
		};
	} catch {
		return { label: checkName, description: "", risk: "", recommendation: "", weight: 5, category: "" };
	}
}

const server = new McpServer({
	name: "vcqa",
	version: "0.1.0",
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
					checks: report.checks.map(c => ({ name: c.name, score: c.score, grade: c.grade, issues: c.issues.length })),
				}, null, 2),
			}],
		};
	},
);

// ── Tool: vcqa_scan ──
server.tool(
	"vcqa_scan",
	"Run a full code health scan. Returns score, grade, and all 22 check results with issues. Use vcqa_score for a quicker summary.",
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
	"Get all code health issues for a specific file. Use this before modifying a file to understand existing problems, or after modifying to check if you introduced new issues.",
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
				if (i.file && (i.file === file || i.file.includes(file))) {
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
	"Get detailed results for a specific check (e.g., 'complexity', 'security', 'testing'). Shows score, issues, and recommendations.",
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
		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify({
					name: c.name,
					score: c.score,
					grade: c.grade,
					details: c.details,
					issues: c.issues,
				}, null, 2),
			}],
		};
	},
);

// ── Tool: vcqa_explain ──
server.tool(
	"vcqa_explain",
	"Explain what a specific check measures, why it matters, and how to fix issues. Use this to understand WHY a check is flagging something.",
	{
		check: z.string().describe("Check name to explain (e.g., 'confusion', 'context', 'architecture')"),
	},
	async ({ check }) => {
		const meta = getCheckMeta(check);
		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify({
					name: check,
					label: meta.label,
					weight: `${meta.weight}%`,
					what: meta.description,
					risk: meta.risk,
					fix: meta.recommendation,
				}, null, 2),
			}],
		};
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
