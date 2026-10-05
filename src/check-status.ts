/**
 * Whether a check actually ran, and how to present one that did not (issue #8).
 *
 * The CLI writes a check that never executed — disabled, not applicable to the
 * stack, Pro key missing, tool missing — with a placeholder `score: 100,
 * grade: "A"` (cli `core.ts` `normalizeCheckResult`). That score is not a
 * measurement, so a consumer must read `status` instead (the rule github-app#9
 * settled on). Reporting "test-audit: 100 (A)" for a Pro check that never ran,
 * or "+36" when a tool disappears between scans, tells an agent something false.
 *
 * Pure functions over report checks so they can be unit-tested without
 * spawning the server.
 */

import type { CheckResult } from "@vibecodeqa/schema";

export type NotRunStatus = "skipped" | "unavailable";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
	const v = obj[key];
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * `"skipped"` / `"unavailable"` when the check did not run, otherwise `null`.
 *
 * Prefers the normalized `status` the CLI writes on the check (and mirrors in
 * `details`). Reports from CLIs that predate that field are derived from the
 * detail flags, as github-app `metric-history.ts` does. A `"runner error:"`
 * reason is deliberately not a non-run: the check executed and failed, and its
 * score is a real data point.
 */
export function notRunStatus(check: CheckResult): NotRunStatus | null {
	const details = isRecord(check.details) ? check.details : {};
	const status = stringField(check as unknown as Record<string, unknown>, "status") ?? stringField(details, "status");
	if (status === "skipped" || status === "unavailable") return status;
	if (status) return null;

	const reason = stringField(details, "reason") ?? "";
	if (reason.startsWith("runner error:")) return null;
	if (details.unavailable || details.comingSoon) return "unavailable";
	if (details.skipped) return "skipped";
	return null;
}

/** The check's run status as reported, or derived for older reports. */
export function checkStatus(check: CheckResult): string | undefined {
	const derived = notRunStatus(check);
	if (derived) return derived;
	const details = isRecord(check.details) ? check.details : {};
	return stringField(check as unknown as Record<string, unknown>, "status") ?? stringField(details, "status");
}

/** "not run (<reason>)" — the reason when the CLI gave one, else the status. */
export function notRunLabel(check: CheckResult, status: NotRunStatus): string {
	const details = isRecord(check.details) ? check.details : {};
	return `not run (${stringField(details, "reason") ?? status})`;
}

/** One line of `vcqa_score`: score/grade only for a check that ran. */
export function scoreEntry(check: CheckResult): Record<string, unknown> {
	const status = checkStatus(check);
	const notRun = notRunStatus(check);
	if (notRun) {
		return { name: check.name, status, result: notRunLabel(check, notRun), issues: check.issues.length };
	}
	return { name: check.name, ...(status ? { status } : {}), score: check.score, grade: check.grade, issues: check.issues.length };
}

/** The score/grade (or not-run) part of `vcqa_check`'s output. */
export function checkResultFields(check: CheckResult): Record<string, unknown> {
	const status = checkStatus(check);
	const notRun = notRunStatus(check);
	if (notRun) return { status, result: notRunLabel(check, notRun) };
	return { ...(status ? { status } : {}), score: check.score, grade: check.grade };
}

export interface ScoreChange {
	name: string;
	before: number;
	after: number;
	delta: number;
}

export interface StatusTransition {
	name: string;
	before: string;
	after: string;
}

export interface CheckDelta {
	/** Both sides ran and the score moved — a real numeric delta. */
	scoreChanges: ScoreChange[];
	/** At least one side did not run (or the check is absent): no number. */
	transitions: StatusTransition[];
}

/** How a check reads on one side of a transition. */
function sideLabel(check: CheckResult | undefined): string {
	if (!check) return "absent";
	const notRun = notRunStatus(check);
	if (notRun) return notRunLabel(check, notRun);
	return `${check.score} (${check.grade})`;
}

/**
 * Per-check comparison for `vcqa_delta`. A numeric delta only exists when both
 * scans ran the check; otherwise the change is reported as a status transition
 * (e.g. "not run (Set VCQA_PRO_KEY …) → 72 (C)"), never as a ±score.
 */
export function diffChecks(before: CheckResult[], after: CheckResult[]): CheckDelta {
	const prevByName = new Map(before.map((c) => [c.name, c]));
	const currNames = new Set(after.map((c) => c.name));
	const scoreChanges: ScoreChange[] = [];
	const transitions: StatusTransition[] = [];

	for (const curr of after) {
		const prev = prevByName.get(curr.name);
		const prevRan = prev !== undefined && notRunStatus(prev) === null;
		const currRan = notRunStatus(curr) === null;
		if (prevRan && currRan) {
			const delta = curr.score - prev.score;
			if (delta !== 0) scoreChanges.push({ name: curr.name, before: prev.score, after: curr.score, delta });
			continue;
		}
		const b = sideLabel(prev);
		const a = sideLabel(curr);
		if (b !== a) transitions.push({ name: curr.name, before: b, after: a });
	}
	for (const prev of before) {
		if (!currNames.has(prev.name)) transitions.push({ name: prev.name, before: sideLabel(prev), after: "absent" });
	}

	scoreChanges.sort((x, y) => y.delta - x.delta);
	return { scoreChanges, transitions };
}
