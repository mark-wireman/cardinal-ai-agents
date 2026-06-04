"""
Interactive Knowledge Graph Query CLI
=======================================
Load a saved graph and explore it interactively.
 
Usage:
    python query_graph.py --graph ./kg_output/knowledge_graph.json
 
Commands (REPL):
    find <name>             – Find nodes by name (fuzzy)
    kind <NodeKind>         – List all nodes of a kind
    neighbors <id>          – Show direct neighbors of a node
    path <src_id> <dst_id>  – Shortest path between two nodes
    subgraph <id> [depth]   – Extract ego subgraph up to depth hops
    stats                   – Print graph statistics
    export <id> [depth]     – Export ego subgraph to JSON
    help                    – Show this help
    quit / exit             – Exit
"""
 
from __future__ import annotations
 
import argparse
import json
import sys
from pathlib import Path
 
import networkx as nx
from colorama import Fore, Style, init as colorama_init
 
from core.graph_store import GraphStore
 
colorama_init(autoreset=True)
 
 
def main() -> None:
    p = argparse.ArgumentParser(description="Query a saved knowledge graph.")
    p.add_argument("--graph", required=True, help="Path to knowledge_graph.json")
    args = p.parse_args()
 
    graph_path = Path(args.graph)
    if not graph_path.exists():
        print(f"Graph file not found: {graph_path}")
        sys.exit(1)
 
    print(f"{Fore.CYAN}Loading graph from {graph_path} …{Style.RESET_ALL}")
    store = GraphStore.load(graph_path)
    stats = store.stats()
    print(f"Loaded {stats['total_nodes']:,} nodes, {stats['total_edges']:,} edges.\n")
    print('Type "help" for available commands.\n')
 
    repl(store)
 
 
def repl(store: GraphStore) -> None:
    G = store.G
    while True:
        try:
            raw = input(f"{Fore.GREEN}kg>{Style.RESET_ALL} ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nBye!")
            break
 
        if not raw:
            continue
 
        parts = raw.split(maxsplit=2)
        cmd   = parts[0].lower()
 
        # ── find ──────────────────────────────────────────────────────────────
        if cmd == "find":
            if len(parts) < 2:
                print("Usage: find <name>")
                continue
            query = parts[1].lower()
            hits  = [
                (nid, G.nodes[nid])
                for nid in G.nodes
                if query in G.nodes[nid].get("name", "").lower()
                or query in nid.lower()
            ]
            if not hits:
                print(f"  No nodes matching '{query}'")
            else:
                for nid, attrs in hits[:30]:
                    _print_node(nid, attrs)
                if len(hits) > 30:
                    print(f"  … and {len(hits)-30} more")
 
        # ── kind ──────────────────────────────────────────────────────────────
        elif cmd == "kind":
            if len(parts) < 2:
                print("Usage: kind <NodeKind>")
                continue
            kind  = parts[1]
            nodes = store.find_by_kind(kind)
            if not nodes:
                print(f"  No nodes of kind '{kind}'")
            else:
                print(f"  {len(nodes)} node(s) of kind '{kind}':")
                for nid in nodes[:40]:
                    _print_node(nid, G.nodes[nid])
                if len(nodes) > 40:
                    print(f"  … and {len(nodes)-40} more")
 
        # ── neighbors ─────────────────────────────────────────────────────────
        elif cmd == "neighbors":
            if len(parts) < 2:
                print("Usage: neighbors <node_id>")
                continue
            nid = parts[1]
            if not G.has_node(nid):
                # Try partial match
                matches = [n for n in G.nodes if parts[1].lower() in n.lower()]
                if len(matches) == 1:
                    nid = matches[0]
                elif matches:
                    print(f"  Ambiguous; did you mean one of:")
                    for m in matches[:10]:
                        print(f"    {m}")
                    continue
                else:
                    print(f"  Node not found: {nid}")
                    continue
 
            print(f"\n  Node: {Fore.CYAN}{nid}{Style.RESET_ALL}")
            _print_node(nid, G.nodes[nid])
 
            out_edges = list(G.out_edges(nid, data=True))
            in_edges  = list(G.in_edges(nid, data=True))
 
            if out_edges:
                print(f"\n  → Outgoing ({len(out_edges)}):")
                for _, dst, d in out_edges[:20]:
                    print(f"      [{d['kind']:20s}] → {dst}  ({G.nodes.get(dst,{}).get('kind','')})")
            if in_edges:
                print(f"\n  ← Incoming ({len(in_edges)}):")
                for src, _, d in in_edges[:20]:
                    print(f"      [{d['kind']:20s}] ← {src}  ({G.nodes.get(src,{}).get('kind','')})")
 
        # ── path ──────────────────────────────────────────────────────────────
        elif cmd == "path":
            if len(parts) < 3:
                print("Usage: path <src_id> <dst_id>")
                continue
            src, dst = parts[1], parts[2]
            try:
                path = nx.shortest_path(G, src, dst)
                print(f"\n  Shortest path ({len(path)-1} hops):")
                for i, nid in enumerate(path):
                    kind = G.nodes.get(nid, {}).get("kind", "?")
                    print(f"    {'→ ' if i else '  '}{nid}  [{kind}]")
            except nx.NetworkXNoPath:
                print("  No path found.")
            except nx.NodeNotFound as e:
                print(f"  Node not found: {e}")
 
        # ── subgraph ──────────────────────────────────────────────────────────
        elif cmd == "subgraph":
            if len(parts) < 2:
                print("Usage: subgraph <node_id> [depth=2]")
                continue
            nid   = parts[1]
            depth = int(parts[2]) if len(parts) > 2 else 2
            if not G.has_node(nid):
                print(f"  Node not found: {nid}")
                continue
            ego = nx.ego_graph(G, nid, radius=depth, undirected=True)
            print(f"\n  Subgraph around '{nid}' (depth={depth}):")
            print(f"  {ego.number_of_nodes()} nodes, {ego.number_of_edges()} edges")
            for n in ego.nodes:
                _print_node(n, G.nodes[n])
 
        # ── stats ─────────────────────────────────────────────────────────────
        elif cmd == "stats":
            s = store.stats()
            print(json.dumps(s, indent=2))
 
        # ── export ────────────────────────────────────────────────────────────
        elif cmd == "export":
            if len(parts) < 2:
                print("Usage: export <node_id> [depth=2]")
                continue
            nid   = parts[1]
            depth = int(parts[2]) if len(parts) > 2 else 2
            if not G.has_node(nid):
                print(f"  Node not found: {nid}")
                continue
            ego      = nx.ego_graph(G, nid, radius=depth, undirected=True)
            out_file = Path(f"subgraph_{nid.replace(':', '_').replace('/', '_')}.json")
            data     = nx.node_link_data(ego)
            out_file.write_text(json.dumps(data, indent=2, default=str))
            print(f"  Exported to {out_file}")
 
        # ── help ──────────────────────────────────────────────────────────────
        elif cmd == "help":
            print(__doc__)
 
        # ── quit ──────────────────────────────────────────────────────────────
        elif cmd in ("quit", "exit", "q"):
            print("Bye!")
            break
 
        else:
            print(f"  Unknown command: '{cmd}'. Type 'help' for options.")
 
 
def _print_node(nid: str, attrs: dict) -> None:
    kind  = attrs.get("kind",  "?")
    name  = attrs.get("name",  "?")
    layer = attrs.get("layer", "?")
    file_ = attrs.get("file",  "")
    line  = attrs.get("line",  "")
 
    layer_colors = {"java": Fore.BLUE, "ts": Fore.GREEN,
                    "js": Fore.YELLOW, "sql": Fore.MAGENTA}
    lc = layer_colors.get(layer, "")
    print(f"  {lc}[{kind:18s}]{Style.RESET_ALL}  {name:30s}  "
          f"{Fore.WHITE}{file_}{':#'+str(line) if line and line != -1 else ''}{Style.RESET_ALL}")
 
 
if __name__ == "__main__":
    main()