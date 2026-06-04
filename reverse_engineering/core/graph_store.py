"""
GraphStore  —  Central Knowledge Graph
========================================
Wraps a NetworkX DiGraph and provides a typed API for:
  • Adding typed nodes  (Class, Method, Field, Table, Column, Route, …)
  • Adding typed edges  (EXTENDS, CALLS, IMPORTS, MAPS_TO, …)
  • Cross-reference resolution between layers
  • Serialisation to JSON and/or GraphML
 
Node attribute schema
---------------------
Every node carries at minimum:
    id        : str   – canonical unique identifier
    kind      : str   – NodeKind value
    name      : str   – short display name
    layer     : str   – "java" | "ts" | "js" | "sql"
    file      : str   – source file path (relative to project root)
    line      : int   – line number (-1 if unknown)
    meta      : dict  – language-specific extras
 
Edge attribute schema
---------------------
    kind      : str   – EdgeKind value
    weight    : int   – multiplicity / call count (default 1)
    meta      : dict  – extras
"""
 
from __future__ import annotations
 
import json
import logging
from collections import defaultdict
from pathlib     import Path
from typing      import Any, Dict, Optional
 
import networkx as nx
 
from core.constants import NodeKind, EdgeKind, node_registry, edge_registry

log = logging.getLogger("graph_store")

# ── Node & Edge kind constants ────────────────────────────────────────────────
 
# class NodeKind:  # Moved to core/constants.py
#     # Java / Spring Boot
#     CLASS       = "Class"
#     INTERFACE   = "Interface"
#     ENUM        = "Enum"
#     ANNOTATION  = "Annotation"
#     METHOD      = "Method"
#     FIELD       = "Field"
#     CONSTRUCTOR = "Constructor"
#     PACKAGE     = "Package"
#     # TypeScript / Angular
#     COMPONENT   = "Component"
#     SERVICE     = "Service"
#     MODULE      = "Module"
#     DIRECTIVE   = "Directive"
#     PIPE        = "Pipe"
#     TS_CLASS    = "TsClass"
#     TS_IFACE    = "TsInterface"
#     TS_ENUM     = "TsEnum"
#     TS_METHOD   = "TsMethod"
#     TS_PROP     = "TsProperty"
#     TS_FUNC     = "TsFunction"
#     # JavaScript / Node.js
#     JS_FUNC     = "JsFunction"
#     JS_CLASS    = "JsClass"
#     JS_VAR      = "JsVariable"
#     JS_ROUTE    = "JsRoute"
#     JS_MWARE    = "JsMiddleware"
#     JS_MODULE   = "JsModule"
#     # SQL / PostgreSQL
#     TABLE       = "Table"
#     COLUMN      = "Column"
#     INDEX       = "Index"
#     VIEW        = "View"
#     SEQUENCE    = "Sequence"
#     FOREIGN_KEY = "ForeignKey"
#     # Cross-layer
#     ENDPOINT    = "Endpoint"
#     DEPENDENCY  = "Dependency"
 
 
# class EdgeKind:  # Moved to core/constants.py
#     EXTENDS        = "EXTENDS"
#     IMPLEMENTS     = "IMPLEMENTS"
#     HAS_METHOD     = "HAS_METHOD"
#     HAS_FIELD      = "HAS_FIELD"
#     HAS_COLUMN     = "HAS_COLUMN"
#     CALLS          = "CALLS"
#     RETURNS        = "RETURNS"
#     IMPORTS        = "IMPORTS"
#     ANNOTATED_WITH = "ANNOTATED_WITH"
#     INJECTS        = "INJECTS"          # DI / @Autowired / constructor inject
#     MAPS_TO        = "MAPS_TO"          # JPA entity → table
#     ROUTES_TO      = "ROUTES_TO"        # HTTP route → controller method
#     REFERENCES     = "REFERENCES"       # FK column → table
#     BELONGS_TO     = "BELONGS_TO"       # column → table, method → class
#     USES_TYPE      = "USES_TYPE"
#     HAS_INDEX      = "HAS_INDEX"
#     EXPORTS        = "EXPORTS"
#     PROVIDES       = "PROVIDES"         # Angular module provides
#     DEPENDS_ON     = "DEPENDS_ON"       # generic dep
 
 
# ── GraphStore ────────────────────────────────────────────────────────────────
 
class GraphStore:
    def __init__(self) -> None:
        self.G: nx.DiGraph = nx.DiGraph()
        # Secondary indexes for fast lookup
        self._by_kind:  Dict[str, list] = defaultdict(list)
        self._by_name:  Dict[str, list] = defaultdict(list)
        self._by_layer: Dict[str, list] = defaultdict(list)
 
    # ── Node API ──────────────────────────────────────────────────────────────
 
    def add_node(
        self,
        node_id: str,
        kind:    str,
        name:    str,
        layer:   str,
        file:    str  = "",
        line:    int  = -1,
        **meta,
    ) -> str:
        """Add or update a node. Returns node_id."""
        attrs = dict(id=node_id, kind=kind, name=name,
                     layer=layer, file=file, line=line, meta=meta)
        if self.G.has_node(node_id):
            self.G.nodes[node_id].update(attrs)
        else:
            self.G.add_node(node_id, **attrs)
            self._by_kind[kind].append(node_id)
            self._by_name[name].append(node_id)
            self._by_layer[layer].append(node_id)
        return node_id
 
    def get_node(self, node_id: str) -> Optional[Dict[str, Any]]:
        return self.G.nodes.get(node_id)

    def has_node(self, node_id: str) -> bool:
        return self.G.has_node(node_id)

    def find_by_name(self, name: str) -> list:
        return self._by_name.get(name, [])
 
    def find_by_kind(self, kind: str) -> list:
        return self._by_kind.get(kind, [])
 
    def nodes_of_layer(self, layer: str) -> list:
        return self._by_layer.get(layer, [])
 
    # ── Edge API ──────────────────────────────────────────────────────────────
 
    def add_edge(
        self,
        src:  str,
        dst:  str,
        kind: str,
        weight: int = 1,
        **meta,
    ) -> None:
        """Add or increment edge weight between two node IDs."""
        if not self.G.has_node(src):
            log.debug(f"Edge source not found, creating stub: {src}")
            self.add_node(src, kind="Unknown", name=src, layer="unknown")
        if not self.G.has_node(dst):
            log.debug(f"Edge target not found, creating stub: {dst}")
            self.add_node(dst, kind="Unknown", name=dst, layer="unknown")
 
        if self.G.has_edge(src, dst):
            self.G[src][dst]["weight"] += weight
        else:
            self.G.add_edge(src, dst, kind=kind, weight=weight, meta=meta)
 
    # ── Cross-reference resolution ────────────────────────────────────────────
 
    def resolve_cross_references(self) -> None:
        """
        Post-processing pass that links nodes across language layers:
          1. Match Java @Entity classes to SQL tables (by snake_case name)
          2. Match Spring @RequestMapping to Angular HttpClient calls (by path)
          3. Match Angular services to Node.js API routes (by URL pattern)
          4. Match HTML class references to CSS class selectors
          5. Match HTML component usages to TypeScript Angular components
        """
        self._link_entities_to_tables()
        self._link_spring_routes_to_angular()
        self._link_angular_services_to_node_routes()
        self._link_html_classes_to_css()
        self._link_html_components_to_ts()
 
    def _link_entities_to_tables(self) -> None:
        entity_nodes = [
            nid for nid in self.find_by_kind(NodeKind.CLASS)
            if self.G.nodes[nid].get("meta", {}).get("is_entity")
        ]
        table_index = {
            self.G.nodes[nid]["name"].lower(): nid
            for nid in self.find_by_kind(NodeKind.TABLE)
        }
        for enid in entity_nodes:
            java_name   = self.G.nodes[enid]["name"]
            snake_name  = _to_snake(java_name).lower()
            table_nid   = (
                table_index.get(self.G.nodes[enid].get("meta", {}).get("table_name", "").lower())
                or table_index.get(snake_name)
                or table_index.get(java_name.lower())
            )
            if table_nid:
                self.add_edge(enid, table_nid, EdgeKind.MAPS_TO)
                log.debug(f"MAPS_TO: {java_name} → {self.G.nodes[table_nid]['name']}")
 
    def _link_spring_routes_to_angular(self) -> None:
        route_nodes = [
            nid for nid in self.find_by_kind(NodeKind.METHOD)
            if self.G.nodes[nid].get("meta", {}).get("http_path")
        ]
        http_calls = [
            nid for nid in self.find_by_kind(NodeKind.TS_METHOD)
            if self.G.nodes[nid].get("meta", {}).get("http_url")
        ]
        for route_nid in route_nodes:
            path = self.G.nodes[route_nid]["meta"].get("http_path", "")
            for call_nid in http_calls:
                url = self.G.nodes[call_nid]["meta"].get("http_url", "")
                if path and url and (path in url or url.endswith(path)):
                    self.add_edge(call_nid, route_nid, EdgeKind.ROUTES_TO)
 
    def _link_angular_services_to_node_routes(self) -> None:
        js_routes = [
            nid for nid in self.find_by_kind(NodeKind.JS_ROUTE)
        ]
        ang_calls = [
            nid for nid in self.find_by_kind(NodeKind.TS_METHOD)
            if self.G.nodes[nid].get("meta", {}).get("http_url")
        ]
        for route_nid in js_routes:
            path = self.G.nodes[route_nid].get("meta", {}).get("path", "")
            for call_nid in ang_calls:
                url = self.G.nodes[call_nid]["meta"].get("http_url", "")
                if path and url and (path in url or url.endswith(path)):
                    self.add_edge(call_nid, route_nid, EdgeKind.ROUTES_TO)

    def _link_html_classes_to_css(self) -> None:
        """Link HTML class references to matching CSS class-selector nodes."""
        # Build index: class name → CSS class node id
        css_class_index: Dict[str, str] = {}
        for nid in self.find_by_kind(NodeKind.CSS_CLASS):
            name_attr = self.G.nodes[nid].get("name", "")
            # Name is stored as ".foo" — strip the leading dot
            cls_name = name_attr.lstrip(".")
            if cls_name:
                css_class_index[cls_name] = nid

        for html_cls_nid in self.find_by_kind(NodeKind.HTML_CLASS_REF):
            cls_name = self.G.nodes[html_cls_nid].get("meta", {}).get("class", "")
            css_nid = css_class_index.get(cls_name)
            if css_nid:
                self.add_edge(html_cls_nid, css_nid, EdgeKind.USES_CLASS)
                log.debug(f"USES_CLASS: {cls_name} (HTML → CSS)")

    def _link_html_components_to_ts(self) -> None:
        """Link HTML component usages to TypeScript Angular component nodes."""
        # Build index: selector → TS component node id
        ts_comp_index: Dict[str, str] = {}
        for nid in self.find_by_kind(NodeKind.COMPONENT):
            selector = self.G.nodes[nid].get("meta", {}).get("selector", "")
            if selector:
                ts_comp_index[selector] = nid

        for html_comp_nid in self.find_by_kind(NodeKind.HTML_COMPONENT):
            selector = self.G.nodes[html_comp_nid].get("meta", {}).get("selector", "")
            ts_nid = ts_comp_index.get(selector)
            if ts_nid:
                self.add_edge(html_comp_nid, ts_nid, EdgeKind.USES_COMPONENT)
                log.debug(f"USES_COMPONENT: <{selector}> (HTML template → TS)")
 
    # ── Statistics ────────────────────────────────────────────────────────────
 
    def stats(self) -> Dict[str, Any]:
        kind_counts: Dict[str, int] = defaultdict(int)
        for _, data in self.G.nodes(data=True):
            kind_counts[data.get("kind", "Unknown")] += 1
 
        edge_counts: Dict[str, int] = defaultdict(int)
        for _, _, data in self.G.edges(data=True):
            edge_counts[data.get("kind", "Unknown")] += 1
 
        return {
            "total_nodes":  self.G.number_of_nodes(),
            "total_edges":  self.G.number_of_edges(),
            "nodes_by_kind": dict(kind_counts),
            "edges_by_kind": dict(edge_counts),
            "layers": {
                layer: len(nodes)
                for layer, nodes in self._by_layer.items()
            },
        }
 
    # ── Serialisation ─────────────────────────────────────────────────────────
 
    def save(self, output_dir: Path, fmt: str = "all") -> None:
        if fmt in ("json", "all"):
            self._save_json(output_dir / "knowledge_graph.json")
        if fmt in ("graphml", "all"):
            self._save_graphml(output_dir / "knowledge_graph.graphml")
        self._save_stats(output_dir / "graph_stats.json")
 
    def _save_json(self, path: Path) -> None:
        data = nx.node_link_data(self.G)
        # Make meta dicts JSON-safe
        for node in data.get("nodes", []):
            node["meta"] = {k: str(v) for k, v in node.get("meta", {}).items()}
        for link in data.get("links", []):
            link["meta"] = {k: str(v) for k, v in link.get("meta", {}).items()}
        path.write_text(json.dumps(data, indent=2, default=str))
        log.info(f"  JSON saved  → {path}")
 
    def _save_graphml(self, path: Path) -> None:
        # GraphML doesn't support dict attributes — flatten meta
        G_copy = nx.DiGraph()
        for nid, attrs in self.G.nodes(data=True):
            flat = {k: v for k, v in attrs.items() if k != "meta"}
            flat.update({f"meta_{k}": str(v) for k, v in attrs.get("meta", {}).items()})
            G_copy.add_node(nid, **flat)
        for src, dst, attrs in self.G.edges(data=True):
            flat = {k: v for k, v in attrs.items() if k != "meta"}
            flat.update({f"meta_{k}": str(v) for k, v in attrs.get("meta", {}).items()})
            G_copy.add_edge(src, dst, **flat)
        nx.write_graphml(G_copy, str(path))
        log.info(f"  GraphML saved → {path}")
 
    def _save_stats(self, path: Path) -> None:
        path.write_text(json.dumps(self.stats(), indent=2))
        log.info(f"  Stats saved  → {path}")
 
    # ── Load ──────────────────────────────────────────────────────────────────
 
    @classmethod
    def load(cls, json_path: Path) -> "GraphStore":
        store = cls()
        data  = json.loads(json_path.read_text())
        store.G = nx.node_link_graph(data)
        for nid, attrs in store.G.nodes(data=True):
            store._by_kind[attrs.get("kind", "Unknown")].append(nid)
            store._by_name[attrs.get("name", "")].append(nid)
            store._by_layer[attrs.get("layer", "unknown")].append(nid)
        return store
 
 
# ── Helpers ───────────────────────────────────────────────────────────────────
 
def _to_snake(name: str) -> str:
    """Convert CamelCase to snake_case."""
    import re
    s1 = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", name)
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s1).lower()