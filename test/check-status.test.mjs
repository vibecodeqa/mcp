/**
 * Checks that did not run must not read as 100/A, and must not produce score
 * deltas (issue #8).
 *
 * The CLI writes a skipped/unavailable check with a placeholder `score: 100,
 * grade: "A"`. These tests run the built `dist/check-status.js` against the
 * committed report fixture — a real report from the pinned engine, which
 * already carries `unavailable` (Pro) and `skipped` (not applicable) checks —
 * and against a pre-`status` copy of it, for reports written by older CLIs.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkResultFields, checkStatus, diffChecks, notRunStatus, scoreEntry } from "../dist/check-status.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "fixture");

function fixtureChecks() {
	const name = readdirSync(fixtureDir).find((f) => /^report-cli-.*\.json$/.test(f));
	ok(name, "no report-cli-*.json fixture");
	return JSON.parse(readFileSync(join(fixtureDir, name), "utf8")).checks;
}

/** The same check as an older CLI wrote it: no `status` anywhere. */
function withoutStatus(check) {
	const { status: _s, ...rest } = check;
	const { status: _d, scoreMode: _m, ...details } = check.details ?? {};
	return { ...rest, details };
}

function byName(checks, name) {
	const c = checks.find((x) => x.name === name);
	ok(c, `fixture has no ${name} check`);
	return c;
}

const checks = fixtureChecks();
const unavailable = byName(checks, "test-audit");
const skipped = byName(checks, "flutter");
const ran = byName(checks, "testing");

/** The CLI's crash stub for a runner that threw (cli `core.ts`): status failed,
 *  a placeholder 0/F, and `skipped` so the composite excludes it. */
const crashed = {
	...ran,
	status: "failed",
	score: 0,
	grade: "F",
	details: { skipped: true, status: "failed", reason: "runner error: boom" },
	issues: [],
};

describe("not-run detection", () => {
	it("the fixture really carries the placeholder 100/A this guards against", () => {
		strictEqual(unavailable.score, 100);
		strictEqual(unavailable.grade, "A");
		strictEqual(unavailable.status, "unavailable");
	});

	it("reads status from the check", () => {
		strictEqual(notRunStatus(unavailable), "unavailable");
		strictEqual(notRunStatus(skipped), "skipped");
		strictEqual(notRunStatus(ran), null);
	});

	it("falls back to details flags for reports without status", () => {
		strictEqual(notRunStatus(withoutStatus(unavailable)), "unavailable");
		strictEqual(notRunStatus(withoutStatus(skipped)), "skipped");
		strictEqual(notRunStatus(withoutStatus(ran)), null);
		strictEqual(notRunStatus({ ...withoutStatus(ran), details: { comingSoon: true } }), "unavailable");
	});

	it("treats a runner error as a check that ran, with status failed", () => {
		strictEqual(notRunStatus(crashed), null);
		strictEqual(checkStatus(crashed), "failed");
		// Older reports: only the skipped flag and the reason.
		const legacy = withoutStatus(crashed);
		strictEqual(notRunStatus(legacy), null);
		strictEqual(checkStatus(legacy), "failed");
	});
});

describe("vcqa_score / vcqa_check entries", () => {
	for (const [label, check] of [["status", unavailable], ["legacy", withoutStatus(unavailable)]]) {
		it(`shows no score or grade for an unavailable check (${label} report)`, () => {
			for (const entry of [scoreEntry(check), checkResultFields(check)]) {
				const text = JSON.stringify(entry);
				strictEqual(entry.score, undefined, text);
				strictEqual(entry.grade, undefined, text);
				ok(!/\b100\b/.test(text), `"100" leaked: ${text}`);
				ok(!/"A"/.test(text), `grade "A" leaked: ${text}`);
				strictEqual(entry.status, "unavailable");
				strictEqual(entry.result, "not run (Set VCQA_PRO_KEY to enable test audit)");
			}
		});
	}

	it("labels a skipped check with its reason", () => {
		const entry = scoreEntry(skipped);
		strictEqual(entry.status, "skipped");
		ok(entry.result.startsWith("not run (not applicable"), entry.result);
	});

	for (const [label, check] of [["status", crashed], ["legacy", withoutStatus(crashed)]]) {
		it(`shows failed (runner error) with no placeholder 0/F for a crashed runner (${label} report)`, () => {
			for (const entry of [scoreEntry(check), checkResultFields(check)]) {
				const text = JSON.stringify(entry);
				strictEqual(entry.score, undefined, text);
				strictEqual(entry.grade, undefined, text);
				strictEqual(entry.status, "failed");
				strictEqual(entry.result, "failed (runner error: boom)");
			}
		});
	}

	it("collapses a multi-line runner-error reason to its first line", () => {
		const stack = { ...crashed, details: { ...crashed.details, reason: "runner error: boom\n    at run (/Users/someone/x.js:1:1)\n    at main" } };
		strictEqual(scoreEntry(stack).result, "failed (runner error: boom)");
		strictEqual(checkResultFields(stack).result, "failed (runner error: boom)");
	});

	it("keeps score and grade for a check that ran", () => {
		const entry = scoreEntry(ran);
		strictEqual(entry.score, ran.score);
		strictEqual(entry.grade, ran.grade);
		strictEqual(entry.status, "passed");
		deepStrictEqual(checkResultFields(ran), { status: "passed", score: ran.score, grade: ran.grade });
	});
});

describe("vcqa_delta check diff", () => {
	const scored72 = { ...unavailable, status: "passed", score: 72, grade: "C", details: { status: "passed" } };
	const crashedAudit = { ...crashed, name: "test-audit" };

	it("unavailable → 72 is a transition, not -28 / +28", () => {
		const { scoreChanges, transitions } = diffChecks([unavailable], [scored72]);
		deepStrictEqual(scoreChanges, []);
		deepStrictEqual(transitions, [{
			name: "test-audit",
			before: "not run (Set VCQA_PRO_KEY to enable test audit)",
			after: "72 (C)",
		}]);
		ok(!/[+-]28/.test(JSON.stringify(transitions)));
	});

	it("72 → unavailable (a tool removed) is a transition too", () => {
		const { scoreChanges, transitions } = diffChecks([scored72], [unavailable]);
		deepStrictEqual(scoreChanges, []);
		strictEqual(transitions.length, 1);
		strictEqual(transitions[0].before, "72 (C)");
	});

	it("legacy-report unavailable → 72 is still a transition", () => {
		const { scoreChanges, transitions } = diffChecks([withoutStatus(unavailable)], [scored72]);
		deepStrictEqual(scoreChanges, []);
		strictEqual(transitions.length, 1);
	});

	it("72 → runner error is a transition, not -72", () => {
		const { scoreChanges, transitions } = diffChecks([scored72], [crashedAudit]);
		deepStrictEqual(scoreChanges, []);
		deepStrictEqual(transitions, [{ name: "test-audit", before: "72 (C)", after: "failed (runner error)" }]);
	});

	it("runner error → 72 is a transition too", () => {
		const { scoreChanges, transitions } = diffChecks([crashedAudit], [scored72]);
		deepStrictEqual(scoreChanges, []);
		deepStrictEqual(transitions, [{ name: "test-audit", before: "failed (runner error)", after: "72 (C)" }]);
	});

	it("transition lines never carry the runner-error reason text", () => {
		const leaky = { ...crashedAudit, details: { ...crashedAudit.details, reason: "runner error: ENOENT /Users/someone/project/x.ts" } };
		const { transitions } = diffChecks([scored72], [leaky]);
		strictEqual(transitions[0].after, "failed (runner error)");
		ok(!JSON.stringify(transitions).includes("/Users/"), "local path leaked into the delta");
	});

	it("two crashes with different reasons are not a transition", () => {
		const other = { ...crashedAudit, details: { ...crashedAudit.details, reason: "runner error: different" } };
		deepStrictEqual(diffChecks([crashedAudit], [other]), { scoreChanges: [], transitions: [] });
	});

	it("keeps numeric deltas when both sides ran", () => {
		const before = { ...ran, score: 50, grade: "D" };
		const { scoreChanges, transitions } = diffChecks([before], [ran]);
		deepStrictEqual(scoreChanges, [{ name: "testing", before: 50, after: ran.score, delta: ran.score - 50 }]);
		deepStrictEqual(transitions, []);
	});

	it("reports nothing when a check stays not-run", () => {
		deepStrictEqual(diffChecks([unavailable], [unavailable]), { scoreChanges: [], transitions: [] });
		deepStrictEqual(diffChecks(checks, checks), { scoreChanges: [], transitions: [] });
	});

	it("a check missing on one side is a transition, not a delta from 0", () => {
		const added = diffChecks([], [ran]);
		deepStrictEqual(added.scoreChanges, []);
		deepStrictEqual(added.transitions, [{ name: "testing", before: "absent", after: `${ran.score} (${ran.grade})` }]);
		const removed = diffChecks([ran], []);
		deepStrictEqual(removed.transitions, [{ name: "testing", before: `${ran.score} (${ran.grade})`, after: "absent" }]);
	});
});
