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

/** The `"runner error: …"` reason when the check's runner crashed, else `null`. */
export function runnerErrorReason(check: CheckResult): string | null {
	const details = isRecord(check.details) ? check.details : {};
	const reason = stringField(details, "reason");
	return reason?.startsWith("runner error:") ? reason : null;
}

/**
 * `"skipped"` / `"unavailable"` when the check did not run, otherwise `null`.
 *
 * Prefers the normalized `status` the CLI writes on the check (and mirrors in
 * `details`). Reports from CLIs that predate that field are derived from the
 * detail flags, as github-app `metric-history.ts` does.
 *
 * A `"runner error:"` reason is not a non-run: the check started and crashed,
 * so it counts as RAN with status `failed` (the CLI's own `checkAvailabilityStatus`,
 * cli#115). Its `0 / F` is still a placeholder, though — the CLI flags it
 * `skipped` so the composite score excludes it — which is what
 * `placeholderLabel` handles.
 */
export function notRunStatus(check: CheckResult): NotRunStatus | null {
	const details = isRecord(check.details) ? check.details : {};
	const status = stringField(check as unknown as Record<string, unknown>, "status") ?? stringField(details, "status");
	if (status === "skipped" || status === "unavailable") return status;
	if (status) return null;

	if (runnerErrorReason(check)) return null;
	if (details.unavailable || details.comingSoon) return "unavailable";
	if (details.skipped) return "skipped";
	return null;
}

/** The check's run status as reported, or derived for older reports. */
export function checkStatus(check: CheckResult): string | undefined {
	const derived = notRunStatus(check);
	if (derived) return derived;
	const details = isRecord(check.details) ? check.details : {};
	const reported = stringField(check as unknown as Record<string, unknown>, "status") ?? stringField(details, "status");
	if (reported) return reported;
	return runnerErrorReason(check) ? "failed" : undefined;
}

/** First non-empty line of a reason — a crashed runner's message can carry a
 *  multi-line stack, which does not belong in a one-line label. */
function firstLine(reason: string): string {
	return reason.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? reason.trim();
}

/** "not run (<reason>)" — the reason when the CLI gave one, else the status. */
export function notRunLabel(check: CheckResult, status: NotRunStatus): string {
	const details = isRecord(check.details) ? check.details : {};
	const reason = stringField(details, "reason");
	return `not run (${reason ? firstLine(reason) : status})`;
}

/**
 * When the check's score/grade is a placeholder rather than a measurement,
 * the label to show instead — `"not run (<reason>)"` for a skipped/unavailable
 * check, `"failed (runner error: …)"` for a crashed runner. `null` means the
 * score is real.
 */
export function placeholderLabel(check: CheckResult): string | null {
	const notRun = notRunStatus(check);
	if (notRun) return notRunLabel(check, notRun);
	const crash = runnerErrorReason(check);
	if (crash) return `failed (${firstLine(crash)})`;
	return null;
}

/** One line of `vcqa_score`: score/grade only when the score is real. */
export function scoreEntry(check: CheckResult): Record<string, unknown> {
	return { name: check.name, ...checkResultFields(check), issues: check.issues.length };
}

/** The score/grade (or placeholder label) part of `vcqa_check`'s output. */
export function checkResultFields(check: CheckResult): Record<string, unknown> {
	const status = checkStatus(check);
	const label = placeholderLabel(check);
	if (label) return { status, result: label };
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
	/** Both sides have a real score and it moved — a numeric delta. */
	scoreChanges: ScoreChange[];
	/** At least one side did not run, crashed, or is absent: no number. */
	transitions: StatusTransition[];
}

/**
 * How a check reads on one side of a `vcqa_delta` transition. A crashed runner
 * is the short form `failed (runner error)`, matching cli#115: the reason text
 * varies run to run (so it is not a state worth diffing) and can contain local
 * paths. The full reason stays in `vcqa_check` / `vcqa_score`.
 */
function sideLabel(check: CheckResult | undefined): string {
	if (!check) return "absent";
	if (notRunStatus(check) === null && runnerErrorReason(check)) return "failed (runner error)";
	return placeholderLabel(check) ?? `${check.score} (${check.grade})`;
}

/**
 * Per-check comparison for `vcqa_delta`. A numeric delta only exists when both
 * scans produced a real score for the check; otherwise the change is reported as a status transition
 * (e.g. "not run (Set VCQA_PRO_KEY …) → 72 (C)", "72 (C) → failed (runner
 * error)"), never as a ±score.
 */
export function diffChecks(before: CheckResult[], after: CheckResult[]): CheckDelta {
	const prevByName = new Map(before.map((c) => [c.name, c]));
	const currNames = new Set(after.map((c) => c.name));
	const scoreChanges: ScoreChange[] = [];
	const transitions: StatusTransition[] = [];

	for (const curr of after) {
		const prev = prevByName.get(curr.name);
		const prevScored = prev !== undefined && placeholderLabel(prev) === null;
		const currScored = placeholderLabel(curr) === null;
		if (prevScored && currScored) {
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
