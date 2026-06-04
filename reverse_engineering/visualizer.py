"""
Graph Visualization Server
---------------------------
Flask-based web server to visualize and interact with the knowledge graph.
Run: python visualizer.py --graph ./kg_output/knowledge_graph.json [--port 5000]
"""

import json
import logging
from pathlib import Path
from typing import Dict, Any, List, Optional
import argparse
import sys

try:
    from flask import Flask, render_template, jsonify, request
    from flask_cors import CORS
except ImportError:
    print("ERROR: Flask not installed. Run: pip install flask flask-cors")
    sys.exit(1)

import networkx as nx

log = logging.getLogger("visualizer")
logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")

app = Flask(__name__, template_folder=".", static_folder=".")
CORS(app)

# Global graph state
G: Optional[nx.DiGraph] = None
graph_stats: Dict[str, Any] = {}
stats_file_path: Optional[Path] = None
current_graph_path: Optional[Path] = None
graph_dir: Optional[Path] = None
available_graph_files: List[Path] = []


def discover_graph_files(base_dir: Path) -> List[Path]:
    """Discover candidate knowledge graph JSON files in a directory."""
    candidates = sorted(
        [
            p for p in base_dir.glob("*.json")
            if p.is_file() and p.name != "graph_stats.json" and "knowledge_graph" in p.stem
        ],
        key=lambda p: p.name.lower(),
    )
    return candidates


def refresh_available_graph_files() -> None:
    """Refresh the in-memory list of selectable graph files."""
    global available_graph_files
    if not graph_dir:
        available_graph_files = []
        return
    available_graph_files = discover_graph_files(graph_dir)


def normalize_stats_payload(data: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize stats payloads from file or computed values into one shape."""
    return {
        "total_nodes": data.get("total_nodes", 0),
        "total_edges": data.get("total_edges", 0),
        "nodes_by_kind": data.get("nodes_by_kind", data.get("node_kinds", {})),
        "edges_by_kind": data.get("edges_by_kind", data.get("edge_kinds", {})),
        "layers": data.get("layers", {}),
        "density": data.get("density", 0),
    }


def load_stats_file(graph_path: Path) -> None:
    """Load graph_stats.json next to the graph file when present."""
    global graph_stats, stats_file_path
    candidate = graph_path.parent / "graph_stats.json"
    if not candidate.exists():
        stats_file_path = None
        return

    try:
        graph_stats = normalize_stats_payload(json.loads(candidate.read_text(encoding="utf-8")))
        stats_file_path = candidate
        log.info(f"Loaded stats file: {candidate}")
    except Exception as e:
        stats_file_path = None
        log.warning(f"Failed to load stats file {candidate}: {e}")


def load_graph(graph_path: Path) -> bool:
    """Load knowledge graph from JSON file."""
    global G, graph_stats, current_graph_path
    try:
        data = json.loads(graph_path.read_text(encoding="utf-8"))
        G = nx.node_link_graph(data, directed=True)
        current_graph_path = graph_path.resolve()
        compute_stats()
        load_stats_file(graph_path)
        log.info(f"Loaded graph: {len(G.nodes())} nodes, {len(G.edges())} edges")
        return True
    except Exception as e:
        log.error(f"Failed to load graph: {e}")
        return False


def compute_stats() -> None:
    """Compute basic graph statistics."""
    global graph_stats
    if not G:
        return
    
    node_kinds: Dict[str, int] = {}
    edge_kinds: Dict[str, int] = {}
    layers: Dict[str, int] = {}
    
    for node, data in G.nodes(data=True):
        kind = data.get("kind", "Unknown")
        node_kinds[kind] = node_kinds.get(kind, 0) + 1
        layer = data.get("layer", "unknown")
        layers[layer] = layers.get(layer, 0) + 1
    
    for src, dst, data in G.edges(data=True):
        kind = data.get("kind", "Unknown")
        edge_kinds[kind] = edge_kinds.get(kind, 0) + 1
    
    graph_stats = normalize_stats_payload({
        "total_nodes": len(G.nodes()),
        "total_edges": len(G.edges()),
        "nodes_by_kind": node_kinds,
        "edges_by_kind": edge_kinds,
        "layers": layers,
        "density": nx.density(G),
    })


def _sorted_counts(items: Dict[str, int]) -> List[Dict[str, Any]]:
    return [
        {"name": name, "count": count}
        for name, count in sorted(items.items(), key=lambda item: (-item[1], item[0]))
    ]


def _node_category(kind: str) -> str:
    """Map concrete node kinds to a user-facing category."""
    k = (kind or "").strip().lower()

    if any(token in k for token in ("class", "iface", "interface", "enum", "entity", "annotation", "type")):
        return "Class"
    if any(token in k for token in ("method", "func", "function", "constructor", "binding", "event", "route", "endpoint")):
        return "Function"
    if any(token in k for token in ("module", "package")):
        return "Module"
    if any(token in k for token in ("component", "directive", "pipe")):
        return "Component"
    if any(token in k for token in ("service", "repository", "controller")):
        return "Service"
    if any(token in k for token in ("table", "column", "index", "view", "foreign", "sql")):
        return "Data"
    if any(token in k for token in ("html", "css", "style", "element", "id_selector", "class_ref", "mixin", "media", "keyframe")):
        return "UI"
    if any(token in k for token in ("field", "prop", "var", "variable", "dependency", "import")):
        return "Property"
    return "Other"


def _build_dashboard_payload() -> Dict[str, Any]:
    payload = normalize_stats_payload(graph_stats)
    total_nodes = payload["total_nodes"] or 1
    total_edges = payload["total_edges"] or 1

    node_category_counts: Dict[str, int] = {}
    node_category_kinds: Dict[str, List[str]] = {}
    for kind_name, count in payload["nodes_by_kind"].items():
        category = _node_category(kind_name)
        node_category_counts[category] = node_category_counts.get(category, 0) + count
        node_category_kinds.setdefault(category, []).append(kind_name)

    node_category_items = _sorted_counts(node_category_counts)
    edge_kind_items = _sorted_counts(payload["edges_by_kind"])
    layer_items = _sorted_counts(payload["layers"])

    summary_cards = [
        {"key": "total_nodes", "label": "Total Nodes", "value": payload["total_nodes"], "tone": "primary"},
        {"key": "total_edges", "label": "Total Edges", "value": payload["total_edges"], "tone": "accent"},
        {"key": "node_kinds", "label": "Node Kinds", "value": len(payload["nodes_by_kind"]), "tone": "success"},
        {"key": "layers", "label": "Layers", "value": len(payload["layers"]), "tone": "warning"},
        {"key": "density", "label": "Density", "value": round(payload["density"], 6), "tone": "neutral"},
    ]

    return {
        "summary": summary_cards,
        "groups": {
            "nodes": {
                "title": "Nodes by Category",
                "group": "node_category",
                "items": [
                    {
                        **item,
                        "share": round(item["count"] / total_nodes, 4),
                        "description": (
                            f"{item['count']:,} nodes across "
                            f"{len(node_category_kinds.get(item['name'], []))} kind(s)"
                        ),
                        "kinds": sorted(node_category_kinds.get(item["name"], [])),
                    }
                    for item in node_category_items
                ],
            },
            "edges": {
                "title": "Edges by Kind",
                "group": "edges",
                "items": [
                    {
                        **item,
                        "share": round(item["count"] / total_edges, 4),
                        "description": f"{item['count']:,} edges of kind {item['name']}"
                    }
                    for item in edge_kind_items
                ],
            },
            "layers": {
                "title": "Layers",
                "group": "layers",
                "items": [
                    {
                        **item,
                        "share": round(item["count"] / total_nodes, 4),
                        "description": f"{item['count']:,} nodes in layer {item['name']}"
                    }
                    for item in layer_items
                ],
            },
        },
        "source": str(stats_file_path) if stats_file_path else "computed",
        "graph_file": current_graph_path.name if current_graph_path else "",
    }


def _resolve_links(subgraph: nx.DiGraph) -> Dict[str, Any]:
    data = nx.node_link_data(subgraph)
    serialized_edges = data.get("links", data.get("edges", []))
    return {
        **data,
        "links": serialized_edges,
        "edges": serialized_edges,
        "meta": {
            "returned_nodes": subgraph.number_of_nodes(),
            "returned_edges": subgraph.number_of_edges(),
        }
    }


def _drilldown_subgraph(group: str, value: str, limit: int, include_neighbors: bool) -> nx.DiGraph:
    if not G:
        raise ValueError("Graph not loaded")

    matched_nodes: set[str] = set()
    matched_edges: List[tuple[str, str]] = []

    if group == "nodes":
        matched_nodes = {nid for nid, data in G.nodes(data=True) if data.get("kind", "Unknown") == value}
    elif group == "node_category":
        matched_nodes = {
            nid for nid, data in G.nodes(data=True)
            if _node_category(data.get("kind", "Unknown")) == value
        }
    elif group == "layers":
        matched_nodes = {nid for nid, data in G.nodes(data=True) if data.get("layer", "unknown") == value}
    elif group == "edges":
        matched_edges = [(src, dst) for src, dst, data in G.edges(data=True) if data.get("kind", "Unknown") == value]
        for src, dst in matched_edges:
            matched_nodes.add(src)
            matched_nodes.add(dst)
    else:
        raise ValueError(f"Unsupported group: {group}")

    if group == "edges" and matched_edges:
        edge_counter = 0
        trimmed = nx.DiGraph()
        for src, dst in matched_edges:
            if edge_counter >= limit:
                break
            if src not in trimmed:
                trimmed.add_node(src, **G.nodes[src])
            if dst not in trimmed:
                trimmed.add_node(dst, **G.nodes[dst])
            trimmed.add_edge(src, dst, **G.edges[src, dst])
            edge_counter += 1
        subgraph = trimmed
    elif matched_nodes:
        if include_neighbors:
            selected_nodes: set[str] = set()
            ordered_seeds = sorted(matched_nodes, key=lambda node_id: G.degree(node_id), reverse=True)

            for seed in ordered_seeds:
                if len(selected_nodes) >= limit:
                    break
                selected_nodes.add(seed)

                neighbors = sorted(
                    set(G.predecessors(seed)).union(G.successors(seed)),
                    key=lambda node_id: G.degree(node_id),
                    reverse=True,
                )
                for neighbor in neighbors:
                    selected_nodes.add(neighbor)
                    if len(selected_nodes) >= limit:
                        break

            subgraph = G.subgraph(selected_nodes).copy()
        else:
            base_subgraph = G.subgraph(matched_nodes).copy()
            if base_subgraph.number_of_nodes() <= limit:
                subgraph = base_subgraph
            else:
                ordered_nodes: List[str] = []
                undirected = base_subgraph.to_undirected()
                components = sorted(nx.connected_components(undirected), key=len, reverse=True)
                for component in components:
                    ordered_nodes.extend(
                        sorted(component, key=lambda node_id: G.degree(node_id), reverse=True)
                    )
                    if len(ordered_nodes) >= limit:
                        break
                subgraph = G.subgraph(ordered_nodes[:limit]).copy()
    else:
        subgraph = nx.DiGraph()

    return subgraph


@app.route("/api/graph/stats")
def get_stats() -> str:
    """Return graph statistics."""
    return jsonify(graph_stats)


@app.route("/api/dashboard")
def get_dashboard() -> str:
    """Return dashboard-ready statistics from graph_stats.json or computed stats."""
    return jsonify(_build_dashboard_payload())


@app.route("/api/graphs")
def get_graph_files() -> str:
    """List available knowledge graph files and the currently active one."""
    refresh_available_graph_files()
    current_name = current_graph_path.name if current_graph_path else ""
    return jsonify({
        "current": current_name,
        "files": [p.name for p in available_graph_files],
    })


@app.route("/api/graphs/select", methods=["POST"])
def select_graph_file() -> str:
    """Switch active graph file by filename."""
    if not graph_dir:
        return jsonify({"error": "Graph directory not configured"}), 500

    payload = request.get_json(silent=True) or {}
    filename = (payload.get("file") or "").strip()
    if not filename:
        return jsonify({"error": "'file' is required"}), 400

    refresh_available_graph_files()
    candidates = {p.name: p for p in available_graph_files}
    selected = candidates.get(filename)
    if not selected:
        return jsonify({"error": f"Graph file not found: {filename}"}), 404

    if not load_graph(selected):
        return jsonify({"error": f"Failed to load graph file: {filename}"}), 500

    return jsonify({
        "ok": True,
        "current": selected.name,
        "stats": {
            "total_nodes": graph_stats.get("total_nodes", 0),
            "total_edges": graph_stats.get("total_edges", 0),
        }
    })


@app.route("/api/graph/by-stat")
def get_graph_by_stat() -> str:
    """Return a graph drilldown for a selected stats item."""
    if not G:
        return jsonify({"error": "Graph not loaded"}), 500

    group = request.args.get("group", "").strip()
    value = request.args.get("value", "").strip()
    include_neighbors = request.args.get("neighbors", "1") != "0"
    limit = min(int(request.args.get("limit", 400)), 1500)

    if not group or not value:
        return jsonify({"error": "Both 'group' and 'value' are required"}), 400

    try:
        subgraph = _drilldown_subgraph(group, value, limit, include_neighbors)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    payload = _resolve_links(subgraph)
    payload["meta"].update({
        "group": group,
        "value": value,
        "include_neighbors": include_neighbors,
        "limit": limit,
        "total_graph_nodes": G.number_of_nodes(),
        "total_graph_edges": G.number_of_edges(),
    })
    return jsonify(payload)


@app.route("/api/graph/data")
def get_graph_data() -> str:
    """Return FULL graph — use only for small graphs (<500 nodes)."""
    if not G:
        return jsonify({"error": "Graph not loaded"}), 500
    data = nx.node_link_data(G)
    return jsonify(data)


@app.route("/api/graph/filtered")
def get_filtered_graph() -> str:
    """
    Return a filtered subgraph for performant rendering.

    Query params:
      layers  : comma-separated layer names  (e.g. ts,java)
      kinds   : comma-separated node kinds   (e.g. Class,Service)
      limit   : max nodes to return          (default 400)
      degree  : only include nodes with degree >= this value (0 = all)
      q       : name/id substring filter
    """
    if not G:
        return jsonify({"error": "Graph not loaded"}), 500

    layers_param = request.args.get("layers", "")
    kinds_param  = request.args.get("kinds", "")
    limit        = min(int(request.args.get("limit", 400)), 2000)
    min_degree   = int(request.args.get("degree", 0))
    q            = request.args.get("q", "").lower()

    layers_filter = set(l.strip() for l in layers_param.split(",") if l.strip())
    kinds_filter  = set(k.strip() for k in kinds_param.split(",")  if k.strip())

    selected_ids = []
    for nid, data in G.nodes(data=True):
        if layers_filter and data.get("layer", "") not in layers_filter:
            continue
        if kinds_filter and data.get("kind", "") not in kinds_filter:
            continue
        if min_degree and G.degree(nid) < min_degree:
            continue
        if q and q not in nid.lower() and q not in data.get("name", "").lower():
            continue
        selected_ids.append(nid)

    # Most-connected nodes first so edges within the slice are maximised
    selected_ids.sort(key=lambda n: G.degree(n), reverse=True)
    selected_ids = selected_ids[:limit]

    sub  = G.subgraph(selected_ids)
    data = nx.node_link_data(sub)
    return jsonify({
        **data,
        "meta": {
            "total_nodes":     G.number_of_nodes(),
            "total_edges":     G.number_of_edges(),
            "returned_nodes":  sub.number_of_nodes(),
            "returned_edges":  sub.number_of_edges(),
            "truncated":       len(selected_ids) == limit,
        }
    })


@app.route("/api/graph/kinds")
def get_kinds() -> str:
    """Return available layers and node kinds with counts for the filter UI."""
    if not G:
        return jsonify({"error": "Graph not loaded"}), 500
    layers: Dict[str, int] = {}
    kinds:  Dict[str, int] = {}
    for _, data in G.nodes(data=True):
        l = data.get("layer", "unknown")
        k = data.get("kind",  "Unknown")
        layers[l] = layers.get(l, 0) + 1
        kinds[k]  = kinds.get(k, 0) + 1
    return jsonify({"layers": layers, "kinds": kinds})


@app.route("/api/search")
def search_nodes() -> str:
    """Fuzzy search nodes by name or ID."""
    if not G:
        return jsonify({"error": "Graph not loaded"}), 500
    
    query = request.args.get("q", "").lower()
    limit = int(request.args.get("limit", 20))
    
    results = []
    for node, data in G.nodes(data=True):
        if query in node.lower() or query in data.get("name", "").lower():
            results.append({
                "id": node,
                "name": data.get("name", node),
                "kind": data.get("kind", "Unknown"),
                "layer": data.get("layer", "unknown"),
            })
            if len(results) >= limit:
                break
    
    return jsonify({"count": len(results), "results": results})


@app.route("/api/node/<node_id>")
def get_node_details(node_id: str) -> str:
    """Get detailed information about a node and its neighbors."""
    if not G or node_id not in G:
        return jsonify({"error": "Node not found"}), 404
    
    node_data = G.nodes[node_id]
    
    # Get neighbors
    predecessors = [
        {
            "id": n,
            "name": G.nodes[n].get("name", n),
            "kind": G.nodes[n].get("kind", "Unknown"),
            "edge_type": G[n][node_id].get("kind", "Unknown"),
        }
        for n in G.predecessors(node_id)
    ]
    
    successors = [
        {
            "id": n,
            "name": G.nodes[n].get("name", n),
            "kind": G.nodes[n].get("kind", "Unknown"),
            "edge_type": G[node_id][n].get("kind", "Unknown"),
        }
        for n in G.successors(node_id)
    ]
    
    return jsonify({
        "id": node_id,
        "data": node_data,
        "predecessors": predecessors,
        "successors": successors,
    })


@app.route("/api/path")
def shortest_path() -> str:
    """Find shortest path between two nodes."""
    if not G:
        return jsonify({"error": "Graph not loaded"}), 500
    
    src = request.args.get("src")
    dst = request.args.get("dst")
    
    if not src or not dst or src not in G or dst not in G:
        return jsonify({"error": "Invalid source or destination"}), 400
    
    try:
        path = nx.shortest_path(G, src, dst)
        path_data = [
            {
                "id": n,
                "name": G.nodes[n].get("name", n),
                "kind": G.nodes[n].get("kind", "Unknown"),
            }
            for n in path
        ]
        return jsonify({"path": path_data, "length": len(path) - 1})
    except nx.NetworkXNoPath:
        return jsonify({"error": "No path exists between nodes"}), 404


@app.route("/api/ego-graph/<node_id>")
def get_ego_graph(node_id: str) -> str:
    """Get ego-graph (node and immediate neighbors)."""
    if not G or node_id not in G:
        return jsonify({"error": "Node not found"}), 404
    
    depth = int(request.args.get("depth", 1))
    ego = nx.ego_graph(G, node_id, radius=depth)
    data = nx.node_link_data(ego)
    return jsonify(data)


@app.route("/")
def index() -> str:
    """Serve statistics-first visualization dashboard."""
    return render_template("visualizer.html")


@app.route("/graph-view")
def graph_view() -> str:
    """Serve the drilldown graph window."""
    return render_template("graph_view.html")


def main():
    parser = argparse.ArgumentParser(description="Graph visualization server")
    parser.add_argument("--graph", type=Path, required=True,
                        help="Path to knowledge_graph.json")
    parser.add_argument("--port", type=int, default=5000,
                        help="Server port (default: 5000)")
    parser.add_argument("--host", default="127.0.0.1",
                        help="Server host (default: 127.0.0.1)")
    args = parser.parse_args()
    
    if not args.graph.exists():
        log.error(f"Graph file not found: {args.graph}")
        sys.exit(1)

    global graph_dir
    graph_dir = args.graph.resolve().parent
    refresh_available_graph_files()
    
    if not load_graph(args.graph):
        sys.exit(1)
    
    log.info(f"Starting visualization server on http://{args.host}:{args.port}")
    log.info(f"Open your browser and navigate to the URL above")
    app.run(host=args.host, port=args.port, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
