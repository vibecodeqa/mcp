/**
 * React architecture reshape — the same classification the monitor's Architecture
 * (Layers) view uses, ported here so `vcqa_architecture` and the UI describe the
 * codebase through one lens. Input is a graphify extraction graph (`{ nodes, links }`);
 * output is symbols bucketed into layers plus the call/import flow between them.
 *
 * Keep in sync with app/src/monitor/views/architecture.logic.ts.
 */

export interface GraphifyNode {
	id: string;
	label?: string;
	source_file?: string;
}
export interface GraphifyEdge {
	source: string;
	target: string;
	relation?: string;
}
export interface GraphifyGraph {
	nodes: GraphifyNode[];
	links: GraphifyEdge[];
}

/** True if a path lives under a hidden/dot directory (.claude, .vscode, .git, …). */
export function isHiddenPath(file: string | undefined | null): boolean {
	if (!file) return false;
	return file.replace(/\\/g, "/").split("/").some((seg) => seg.startsWith("."));
}

/**
 * Drop nodes whose source file lives under a hidden/tooling directory (.claude,
 * .vscode, .github, …) and any link touching them. graphify walks the whole repo
 * including dotfolders, but those are config/tooling, not application source.
 */
export function stripHiddenNodes(graph: GraphifyGraph | null | undefined): GraphifyGraph {
	const nodes = Array.isArray(graph?.nodes) ? graph!.nodes : [];
	const links = Array.isArray(graph?.links) ? graph!.links : [];
	const kept = nodes.filter((n) => n && !isHiddenPath(n.source_file));
	const keptIds = new Set(kept.map((n) => n.id));
	return { nodes: kept, links: links.filter((l) => l && keptIds.has(l.source) && keptIds.has(l.target)) };
}

export type LayerId = "pages" | "components" | "hooks" | "state" | "services" | "lib" | "data";
export type NodeKind = "component" | "hook" | "page" | "store" | "service" | "util" | "type" | "file" | "other";

export interface ArchNode { id: string; name: string; kind: NodeKind; layer: LayerId | null; file: string; }
export interface ArchLayer { id: LayerId; label: string; hint: string; nodes: ArchNode[]; }
export interface LayerFlow { from: LayerId; to: LayerId; calls: number; imports: number; }
export interface ArchitectureModel {
	layers: ArchLayer[];
	flows: LayerFlow[];
	stats: { symbols: number; components: number; hooks: number; services: number; files: number };
}

export const LAYER_ORDER: { id: LayerId; label: string; hint: string }[] = [
	{ id: "pages", label: "Routes / Pages", hint: "route-level screens" },
	{ id: "components", label: "Components", hint: "UI building blocks" },
	{ id: "hooks", label: "Hooks", hint: "reusable stateful logic" },
	{ id: "state", label: "State / Context", hint: "context, stores" },
	{ id: "services", label: "Services / API", hint: "data access, network" },
	{ id: "lib", label: "Lib / Utils", hint: "pure helpers, types" },
	{ id: "data", label: "Data / DB", hint: "schema, migrations, queries" },
];

const FILE_RE = /\.(tsx?|jsx?|json|css|scss|md|svg|html)$/i;

function areaOf(id: string): string {
	const seg = id.split(/[/_]/)[0];
	const known = ["pages", "components", "hooks", "lib", "db", "app", "main", "utils", "services", "api", "store", "stores", "context", "contexts", "state", "features", "routes", "views"];
	if (known.includes(seg)) return seg;
	const m = id.match(/[/_](pages|components|hooks|lib|db|services|api|stores?|contexts?|state|routes|views)[/_]/);
	return m ? m[1] : "other";
}

export function classify(node: GraphifyNode): { kind: NodeKind; layer: LayerId | null } {
	// Coerce: graphify output is untrusted JSON — a non-string label must not throw.
	const lbl = String(node.label ?? "").trim();
	if (!lbl || FILE_RE.test(lbl)) return { kind: "file", layer: null };

	const isFn = lbl.endsWith("()");
	const name = lbl.replace(/\(\)$/, "");
	const isPascal = /^[A-Z]/.test(name);
	const area = areaOf(node.id);
	const inTsx = /\.(tsx|jsx)$/i.test(node.source_file ?? "");

	if (/^use[A-Z]/.test(name)) return { kind: "hook", layer: "hooks" };
	if (/(Context|Provider|Store)$/.test(name) || area === "state" || area === "context" || area === "contexts" || area === "store" || area === "stores")
		return { kind: "store", layer: "state" };

	if (isFn && isPascal && (area === "components" || area === "pages" || area === "views" || area === "features" || inTsx))
		return { kind: "component", layer: area === "pages" || area === "routes" || area === "views" ? "pages" : "components" };

	if (area === "pages" || area === "routes" || area === "views") return { kind: isFn ? "component" : "type", layer: "pages" };
	if (area === "components" || area === "features") return { kind: isFn ? "component" : "type", layer: "components" };
	if (area === "db") return { kind: isFn ? "service" : "type", layer: "data" };
	if (area === "services" || area === "api") return { kind: "service", layer: "services" };
	if (area === "lib" || area === "utils") {
		if (isFn && /(api|fetch|client|http|invite|admin|migrat|worker|request|mutation|query|upload|download|sync)/i.test(name))
			return { kind: "service", layer: "services" };
		return { kind: isFn ? "util" : "type", layer: "lib" };
	}
	if (!isFn && isPascal) return { kind: "type", layer: "lib" };
	return { kind: isFn ? "util" : "other", layer: "lib" };
}

export function buildArchitecture(graph: GraphifyGraph | null | undefined): ArchitectureModel {
	// Tolerate malformed/adversarial graphify JSON: only iterate real arrays.
	const nodes = Array.isArray(graph?.nodes) ? graph!.nodes : [];
	const links = Array.isArray(graph?.links) ? graph!.links : [];

	const byLayer = new Map<LayerId, ArchNode[]>();
	for (const L of LAYER_ORDER) byLayer.set(L.id, []);
	const layerOf = new Map<string, LayerId | null>();
	const seenId = new Set<string>();
	let files = 0, components = 0, hooks = 0, services = 0, symbols = 0;

	for (const n of nodes) {
		if (!n || typeof n.id !== "string" || seenId.has(n.id)) continue;
		seenId.add(n.id);
		const { kind, layer } = classify(n);
		layerOf.set(n.id, layer);
		if (kind === "file") { files++; continue; }
		if (!layer) continue;
		symbols++;
		if (kind === "component") components++;
		if (kind === "hook") hooks++;
		if (kind === "service") services++;
		byLayer.get(layer)!.push({ id: n.id, name: String(n.label ?? "").replace(/\(\)$/, ""), kind, layer, file: n.source_file ?? "" });
	}

	const kindRank: Record<NodeKind, number> = { page: 0, component: 0, hook: 0, store: 1, service: 1, util: 2, type: 3, file: 4, other: 4 };
	for (const arr of byLayer.values())
		arr.sort((a, b) => kindRank[a.kind] - kindRank[b.kind] || a.name.localeCompare(b.name));

	const flowMap = new Map<string, LayerFlow>();
	for (const e of links) {
		const a = layerOf.get(e.source), b = layerOf.get(e.target);
		if (!a || !b || a === b) continue;
		const isCall = e.relation === "calls" || e.relation === "indirect_call" || e.relation === "method";
		const isImport = e.relation === "imports" || e.relation === "imports_from";
		if (!isCall && !isImport) continue;
		const key = `${a}>${b}`;
		const f = flowMap.get(key) ?? { from: a, to: b, calls: 0, imports: 0 };
		if (isCall) f.calls++; else f.imports++;
		flowMap.set(key, f);
	}
	const flows = [...flowMap.values()].sort((a, b) => b.calls + b.imports - (a.calls + a.imports));

	const layers = LAYER_ORDER.map((L) => ({ id: L.id, label: L.label, hint: L.hint, nodes: byLayer.get(L.id)! }));
	return { layers, flows, stats: { symbols, components, hooks, services, files } };
}
