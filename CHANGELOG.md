# Changelog

## 0.6.0

### Pin to the current CLI (#9)
- **Changed**: live scans run `@vibecodeqa/cli@^0.57.0` (was `^0.55.0`). On a
  `0.x` version a caret is a minor range, so the old pin never resolved 0.56 or
  0.57. Results come from the 0.57 engine, so scores and findings can change
  with no change in your code. See the
  [CLI changelog](https://github.com/vibecodeqa/cli/blob/main/CHANGELOG.md) for
  0.56.0 and 0.57.0.
- **Changed**: reports from the new engine carry `meta.fingerprintVersion: 2`.
  Issue fingerprints are computed differently from earlier reports, so treat a
  `fingerprintVersion` change as a re-baseline if you store them yourself.
- **Changed**: `@vibecodeqa/schema` moves to `^0.6.0`, which adds types for the
  fields the 0.57 engine writes: check `status`, issue `fingerprint` /
  `subject`, and report provenance (`meta.git`, `meta.ci`, `meta.scan`). Every
  check the 0.57 engine emits, including the new `cloudflare-worker-mcp`, has
  `vcqa_explain` metadata.
- **Documented**: the pin policy, a caret on the current CLI minor, is in the
  README under "Scan engine version".

### Checks that did not run are no longer scored (#8)
A check that was skipped or unavailable carries a placeholder `score: 100,
grade: "A"` in the report, and a crashed runner a placeholder `0`/`F`.
- **Changed**: in `vcqa_score` and `vcqa_check`, each check entry now has a
  `status`. When the score is a placeholder, the entry has **no `score` or
  `grade`**. It has a `result` label instead: `"not run (<reason>)"` or
  `"failed (runner error: …)"`. Clients that read `score` on every entry need
  to handle its absence.
- **Changed**: `vcqa_delta` gives a numeric per-check delta only when both scans
  have a real score. Anything else is listed under "Status changes", for
  example `test-audit: not run (…) → 72 (C)` or `lint: 72 (C) → failed (runner
  error)`. A check missing from one side is an `absent` transition, not a delta
  from 0.
- **Changed**: `vcqa_scan` still returns the raw report, placeholder scores
  included. Its description now tells the model to read `status`.
