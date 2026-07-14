/**
 * Call-flow analysis for the MCP `vcqa_callflow` tool — mirror of the app's
 * callflow.logic.ts. Builds a symbol-level call graph from graphify's `calls`
 * edges, finds entry points, and traces a chosen root's downstream call tree.
 *
 * Keep in sync with app/src/monitor/views/callflow.logic.ts.
 */

import { classify, type GraphifyGraph, type LayerId, type NodeKind } from "./architecture.js";

export interface CallNode { id: string; name: string; kind: NodeKind; layer: LayerId; file: string; }
export interface CallGraph {
	nodes: Map<string, CallNode>;
	out: Map<string, string[]>;
	inn: Map<string, string[]>;
}
export interface TracedNode extends CallNode { depth: number; }
export interface CallTrace { root: string; nodes: TracedNode[]; edges: { from: string; to: string }[]; truncated: boolean; }
export interface EntryPoint extends CallNode { reach: number; }

const CALL_RELS = new Set(["calls", "indirect_call", "method"]);

export function buildCallGraph(graph: GraphifyGraph | null | undefined): CallGraph {
	const nodes = new Map<string, CallNode>();
	const out = new Map<string, string[]>();
	const inn = new Map<string, string[]>();
	// Tolerate malformed/adversarial graphify JSON: only iterate real arrays.
	const rawNodes = Array.isArray(graph?.nodes) ? graph!.nodes : [];
	const rawLinks = Array.isArray(graph?.links) ? graph!.links : [];
	for (const n of rawNodes) {
		if (!n || typeof n.id !== "string" || nodes.has(n.id)) continue;
		const { kind, layer } = classify(n);
		if (kind === "file" || !layer) continue;
		nodes.set(n.id, { id: n.id, name: String(n.label ?? "").replace(/\(\)$/, ""), kind, layer, file: n.source_file ?? "" });
		out.set(n.id, []);
		inn.set(n.id, []);
	}
	const seen = new Set<string>();
	for (const e of rawLinks) {
		if (!e || !CALL_RELS.has(e.relation ?? "")) continue;
		if (!nodes.has(e.source) || !nodes.has(e.target) || e.source === e.target) continue;
		const key = e.source + ">" + e.target;
		if (seen.has(key)) continue;
		seen.add(key);
		out.get(e.source)!.push(e.target);
		inn.get(e.target)!.push(e.source);
	}
	return { nodes, out, inn };
}

function reachOf(cg: CallGraph, id: string): number {
	const seen = new Set<string>([id]);
	const stack = [id];
	while (stack.length) {
		for (const nx of cg.out.get(stack.pop()!) ?? []) if (!seen.has(nx)) { seen.add(nx); stack.push(nx); }
	}
	return seen.size - 1;
}

// Above this size, exact per-candidate reach (a DFS each) turns quadratic — rank
// by out-degree instead. Mirrors app/src/monitor/views/callflow.logic.ts.
const EXACT_REACH_LIMIT = 3000;

export function entryPoints(cg: CallGraph): EntryPoint[] {
	const exact = cg.nodes.size <= EXACT_REACH_LIMIT;
	const eps: EntryPoint[] = [];
	for (const [id, node] of cg.nodes) {
		const outs = cg.out.get(id)!.length;
		if (outs === 0) continue;
		const isRoot = cg.inn.get(id)!.length === 0;
		const isEntryKind = node.kind === "component" || node.kind === "page" || node.kind === "hook";
		if (!isRoot && !isEntryKind) continue;
		eps.push({ ...node, reach: exact ? reachOf(cg, id) : outs });
	}
	eps.sort((a, b) => b.reach - a.reach || a.name.localeCompare(b.name));
	return eps;
}

export function traceFrom(cg: CallGraph, root: string, opts: { maxNodes?: number; maxDepth?: number } = {}): CallTrace {
	const maxNodes = opts.maxNodes ?? 60;
	const maxDepth = opts.maxDepth ?? 6;
	if (!cg.nodes.has(root)) return { root, nodes: [], edges: [], truncated: false };
	const depth = new Map<string, number>([[root, 0]]);
	const queue: string[] = [root];
	let truncated = false;
	for (let qi = 0; qi < queue.length; qi++) {
		const id = queue[qi];
		const d = depth.get(id)!;
		if (d >= maxDepth) { if (cg.out.get(id)!.length) truncated = true; continue; }
		for (const nx of cg.out.get(id)!) {
			if (depth.has(nx)) continue;
			if (depth.size >= maxNodes) { truncated = true; continue; }
			depth.set(nx, d + 1);
			queue.push(nx);
		}
	}
	const included = new Set(depth.keys());
	const nodes: TracedNode[] = [...included].map((id) => ({ ...cg.nodes.get(id)!, depth: depth.get(id)! }))
		.sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));
	const edges: { from: string; to: string }[] = [];
	for (const id of included) for (const nx of cg.out.get(id)!) if (included.has(nx)) edges.push({ from: id, to: nx });
	return { root, nodes, edges, truncated };
}

/** Resolve a user-supplied root (symbol name or id) to a node id. */
export function resolveRoot(cg: CallGraph, root: string): string | null {
	if (cg.nodes.has(root)) return root;
	const lc = root.replace(/\(\)$/, "").toLowerCase();
	for (const [id, n] of cg.nodes) if (n.name.toLowerCase() === lc) return id;
	return null;
}
