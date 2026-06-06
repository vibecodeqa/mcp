# @vibecodeqa/mcp

MCP server for VibeCode QA — gives AI coding agents real-time code health context.

When an AI agent writes or modifies code, it can query vcqa to check: "Is this file healthy? What patterns should I follow? Will this change degrade quality?"

## Quick start

### Claude Code

```bash
claude mcp add vcqa -- npx @vibecodeqa/mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vcqa": {
      "command": "npx",
      "args": ["@vibecodeqa/mcp"]
    }
  }
}
```

### Cursor / other MCP clients

```bash
npx @vibecodeqa/mcp
```

## Tools

| Tool | Description |
|------|-------------|
| `vcqa_score` | Quick score + grade + check summary (uses cache) |
| `vcqa_scan` | Full scan — all 34 checks with issues and details |
| `vcqa_file_health` | Issues for a specific file (use before/after editing) |
| `vcqa_check` | Detailed results for one check (e.g., "complexity") |
| `vcqa_explain` | What a check measures, why it matters, how to fix |
| `vcqa_fix` | AI-powered fix for code issues (needs ANTHROPIC_API_KEY) |

## How agents use it

**Before modifying a file:**
```
→ vcqa_file_health({ file: "src/auth.ts" })
← 3 issues: complexity 28 (max 15), empty catch block, no test file
```
The agent now knows to simplify the function, add error handling, and write a test.

**After generating code:**
```
→ vcqa_score()
← B 78/100 (was B 80 — dropped 2 pts)
→ vcqa_check({ check: "security" })
← 1 new issue: innerHTML assignment in src/dashboard.tsx:42
```
The agent fixes the security issue before committing.

**Understanding a check:**
```
→ vcqa_explain({ check: "confusion" })
← Measures naming ambiguity that causes LLMs to edit the wrong file...
```

## Performance

- Uses cached `report.json` from previous CLI runs (< 5 min old)
- Falls back to live scan via `npx @vibecodeqa/cli --skip-tests --json`
- In-memory cache with 60s TTL prevents redundant scans
- Typical response: < 100ms (cached), 3-8s (live scan)

## Links

- [VibeCode QA CLI](https://www.npmjs.com/package/@vibecodeqa/cli)
- [Website](https://vibecodeqa.online)
- [GitHub](https://github.com/vibecodeqa/mcp)
