"""
SummaryReporter
----------------
Prints a human-readable breakdown of the knowledge graph to stdout.
"""
 
from __future__ import annotations
 
from colorama import Fore, Style
 
from core.graph_store import GraphStore, NodeKind, EdgeKind
 
 
_LAYER_COLORS = {
    "java": Fore.BLUE,
    "ts":   Fore.GREEN,
    "js":   Fore.YELLOW,
    "sql":  Fore.MAGENTA,
}
 
_INTERESTING_KINDS = [
    NodeKind.CLASS,    NodeKind.INTERFACE,  NodeKind.ENUM,
    NodeKind.COMPONENT, NodeKind.SERVICE,   NodeKind.MODULE,
    NodeKind.METHOD,   NodeKind.TS_METHOD,  NodeKind.JS_ROUTE,
    NodeKind.TABLE,    NodeKind.COLUMN,     NodeKind.FOREIGN_KEY,
    NodeKind.ENDPOINT,
]
 
 
class SummaryReporter:
    def __init__(self, graph: GraphStore) -> None:
        self.graph = graph
 
    def print(self) -> None:
        stats = self.graph.stats()
        g     = self.graph.G
 
        print(f"\n{Fore.CYAN}{'═' * 60}")
        print(f"  Knowledge Graph Summary")
        print(f"{'═' * 60}{Style.RESET_ALL}")
        print(f"  Nodes : {stats['total_nodes']:,}")
        print(f"  Edges : {stats['total_edges']:,}")
 
        # Per-layer breakdown
        print(f"\n{Fore.CYAN}  Layer Breakdown{Style.RESET_ALL}")
        for layer, count in sorted(stats["layers"].items()):
            color = _LAYER_COLORS.get(layer, "")
            print(f"    {color}{layer:8s}{Style.RESET_ALL}  {count:,} nodes")
 
        # Node kinds
        print(f"\n{Fore.CYAN}  Node Kinds{Style.RESET_ALL}")
        for kind in _INTERESTING_KINDS:
            cnt = stats["nodes_by_kind"].get(kind, 0)
            if cnt:
                print(f"    {kind:20s}  {cnt:,}")
 
        # Edge kinds
        print(f"\n{Fore.CYAN}  Edge Kinds{Style.RESET_ALL}")
        for ekind, cnt in sorted(stats["edges_by_kind"].items(), key=lambda x: -x[1]):
            print(f"    {ekind:20s}  {cnt:,}")
 
        # HTTP endpoints
        self._print_http_endpoints()
 
        # Tables + FK
        self._print_tables()
 
        # Entity → Table mappings
        self._print_entity_mappings()
 
        print(f"\n{Fore.CYAN}{'═' * 60}{Style.RESET_ALL}\n")
 
    # ── Sections ──────────────────────────────────────────────────────────────
 
    def _print_http_endpoints(self) -> None:
        routes = self.graph.find_by_kind(NodeKind.JS_ROUTE)
        spring = [
            nid for nid in self.graph.find_by_kind(NodeKind.METHOD)
            if self.graph.G.nodes[nid].get("meta", {}).get("is_http_handler")
        ]
        if not routes and not spring:
            return
        print(f"\n{Fore.CYAN}  HTTP Endpoints{Style.RESET_ALL}")
        for nid in routes[:20]:
            n = self.graph.G.nodes[nid]
            verb = n.get("meta", {}).get("verb", "")
            path = n.get("meta", {}).get("path", n["name"])
            print(f"    {Fore.YELLOW}{verb:8s}{Style.RESET_ALL} {path}")
        for nid in spring[:20]:
            n = self.graph.G.nodes[nid]
            m = n.get("meta", {})
            print(f"    {Fore.BLUE}{m.get('http_verb',''):8s}{Style.RESET_ALL} {m.get('http_path','')}")
        total = len(routes) + len(spring)
        if total > 20:
            print(f"    … and {total - 20} more")
 
    def _print_tables(self) -> None:
        tables = self.graph.find_by_kind(NodeKind.TABLE)
        if not tables:
            return
        print(f"\n{Fore.CYAN}  Database Tables{Style.RESET_ALL}")
        for tid in sorted(tables, key=lambda n: self.graph.G.nodes[n]["name"]):
            tname = self.graph.G.nodes[tid]["name"]
            col_count = sum(
                1 for _, _, d in self.graph.G.edges(tid, data=True)
                if d.get("kind") == EdgeKind.HAS_COLUMN
            )
            fk_count  = sum(
                1 for _, _, d in self.graph.G.edges(tid, data=True)
                if d.get("kind") == EdgeKind.REFERENCES
            )
            print(f"    {Fore.MAGENTA}{tname:30s}{Style.RESET_ALL}"
                  f"  {col_count:3d} cols   {fk_count:2d} FK(s)")
 
    def _print_entity_mappings(self) -> None:
        mappings = [
            (s, t) for s, t, d in self.graph.G.edges(data=True)
            if d.get("kind") == EdgeKind.MAPS_TO
        ]
        if not mappings:
            return
        print(f"\n{Fore.CYAN}  Entity → Table Mappings{Style.RESET_ALL}")
        for src, dst in mappings:
            sn = self.graph.G.nodes[src]["name"]
            dn = self.graph.G.nodes.get(dst, {}).get("name", dst)
            print(f"    {Fore.BLUE}{sn:30s}{Style.RESET_ALL} → {Fore.MAGENTA}{dn}{Style.RESET_ALL}")