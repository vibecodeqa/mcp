/**
 * Sequence approximation for the MCP `vcqa_sequence` tool — mirror of the app's
 * sequence.logic.ts. Linearizes a call tree into an execution-ordered message
 * list (DFS pre-order) and renders it to Mermaid.
 *
 * Keep in sync with app/src/monitor/views/sequence.logic.ts.
 */

import type { CallGraph } from "./callflow.js";
import type { LayerId, NodeKind } from "./architecture.js";

// `from`/`to` are node *ids* (unique), not names — same-named symbols stay distinct.
export interface SeqParticipant { id: string; name: string; kind: NodeKind; layer: LayerId; }
export interface SeqStep { from: string; to: string; label: string; depth: number; }
export interface Sequence { root: string; participants: SeqParticipant[]; steps: SeqStep[]; truncated: boolean; }

export function buildSequence(cg: CallGraph, root: string, opts: { maxSteps?: number; maxDepth?: number } = {}): Sequence {
	const maxSteps = opts.maxSteps ?? 40;
	const maxDepth = opts.maxDepth ?? 6;
	const rootNode = cg.nodes.get(root);
	if (!rootNode) return { root, participants: [], steps: [], truncated: false };

	const steps: SeqStep[] = [];
	const participants: SeqParticipant[] = [];
	const seen = new Set<string>();
	const add = (id: string) => {
		if (seen.has(id)) return;
		seen.add(id);
		const n = cg.nodes.get(id)!;
		participants.push({ id, name: n.name, kind: n.kind, layer: n.layer });
	};
	add(root);

	let truncated = false;
	const onPath = new Set<string>([root]);
	const walk = (id: string, depth: number) => {
		if (depth >= maxDepth) { if (cg.out.get(id)!.length) truncated = true; return; }
		for (const callee of cg.out.get(id)!) {
			if (steps.length >= maxSteps) { truncated = true; return; }
			steps.push({ from: id, to: callee, label: cg.nodes.get(callee)!.name + "()", depth });
			add(callee);
			if (!onPath.has(callee)) { onPath.add(callee); walk(callee, depth + 1); onPath.delete(callee); }
		}
	};
	walk(root, 0);
	return { root: rootNode.name, participants, steps, truncated };
}

export function toMermaid(seq: Sequence): string {
	const alias = new Map<string, string>();
	seq.participants.forEach((p, i) => alias.set(p.id, `P${i}`));
	const a = (id: string) => alias.get(id) ?? id;
	const lines: string[] = ["sequenceDiagram"];
	for (const p of seq.participants) lines.push(`  participant ${a(p.id)} as ${p.name}`);
	for (const s of seq.steps) lines.push(`  ${a(s.from)}->>${a(s.to)}: ${s.label}`);
	if (seq.truncated) lines.push(`  Note over ${a(seq.participants[0]?.id ?? "P0")}: … truncated`);
	return lines.join("\n");
}
