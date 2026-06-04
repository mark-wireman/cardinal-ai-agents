# Full-Stack Reverse Engineering Agent

## Project Layout

```
reverse_engineer/
├── agent.py                  ← Main orchestrator (run this)
├── query_graph.py            ← Interactive REPL for exploring the saved graph
├── requirements.txt
├── core/
│   ├── __init__.py
│   ├── scanner.py            ← File discovery & bucketing
│   └── graph_store.py        ← NetworkX-backed knowledge graph + serialisation
├── parsers/
│   ├── __init__.py
│   ├── java_parser.py        ← Spring Boot / Java AST (via javalang)
│   ├── ts_parser.py          ← Angular / TypeScript (regex + structural)
│   ├── js_parser.py          ← Node.js / Express (regex)
│   └── sql_parser.py         ← PostgreSQL DDL (sqlparse + regex)
└── reporters/
    ├── __init__.py
    └── summary.py            ← Console report with colour output
```

---

## requirements.txt

```
javalang>=0.13.0
networkx>=3.2
sqlparse>=0.5.0
colorama>=0.4.6
tqdm>=4.66
```

Install with:
```bash
pip install -r requirements.txt
```

---

## Running the Agent

### Step 1 — Reverse-engineer a project
```bash
python agent.py \
  --root  /path/to/your/project \
  --output ./kg_output \
  --format all \
  --skip node_modules target .git dist
```

Options:
| Flag | Description |
|------|-------------|
| `--root` | Root folder of the full-stack project |
| `--output` | Where to write graph files (default: `./kg_output`) |
| `--format` | `json` \| `graphml` \| `all` (default: `all`) |
| `--skip` | Space-separated directory names to exclude |
| `--verbose` | Enable debug logging |

### Step 2 — Query the graph interactively
```bash
python query_graph.py --graph ./kg_output/knowledge_graph.json
```

#### REPL commands
| Command | Description |
|---------|-------------|
| `find <name>` | Fuzzy-search nodes by name |
| `kind <NodeKind>` | List all nodes of a type (e.g. `kind Table`, `kind Component`) |
| `neighbors <id>` | Show all edges in/out of a node |
| `path <src> <dst>` | Shortest path between two nodes |
| `subgraph <id> [depth]` | Print ego-graph (default depth = 2) |
| `stats` | Full statistics JSON |
| `export <id> [depth]` | Save ego-subgraph as JSON file |
| `help` | Show help |
| `quit` | Exit |

---

## Output Files

| File | Description |
|------|-------------|
| `knowledge_graph.json` | Full graph in node-link JSON (loadable by NetworkX / D3.js) |
| `knowledge_graph.graphml` | GraphML format (open in yEd, Gephi, Cytoscape) |
| `graph_stats.json` | Node/edge counts by kind and layer |

---

## Node Kinds

| Kind | Layer | Description |
|------|-------|-------------|
| `Class` | java | Java class (plain or Spring stereotype) |
| `Interface` | java | Java interface |
| `Enum` | java | Java enum |
| `Method` | java | Java method (incl. HTTP handler methods) |
| `Field` | java | Java field / @Column |
| `Component` | ts | Angular @Component |
| `Service` | ts | Angular @Injectable service |
| `Module` | ts | Angular @NgModule |
| `TsClass` | ts | Plain TypeScript class |
| `TsInterface` | ts | TypeScript interface |
| `TsMethod` | ts | TypeScript method (records HTTP URL if found) |
| `JsFunction` | js | JavaScript function or arrow |
| `JsRoute` | js | Express route (verb + path) |
| `JsModule` | js | Node.js module |
| `Table` | sql | PostgreSQL table |
| `Column` | sql | Table column (type, PK, NOT NULL, DEFAULT) |
| `ForeignKey` | sql | FK constraint |
| `Index` | sql | Index |
| `View` | sql | SQL view |
| `Endpoint` | cross | HTTP endpoint resolved across layers |

## Edge Kinds

`EXTENDS · IMPLEMENTS · HAS_METHOD · HAS_FIELD · HAS_COLUMN · CALLS · RETURNS · IMPORTS · ANNOTATED_WITH · INJECTS · MAPS_TO · ROUTES_TO · REFERENCES · BELONGS_TO · USES_TYPE · HAS_INDEX · EXPORTS · PROVIDES · DEPENDS_ON`

---

## Extending the Agent

1. **Add a new parser** — create `parsers/my_parser.py`, implement `parse(path: Path)`, and call `self.graph.add_node / add_edge`.
2. **New node/edge kinds** — add constants to `NodeKind` / `EdgeKind` in `core/graph_store.py`.
3. **New cross-layer links** — add a private `_link_*` method to `GraphStore.resolve_cross_references()`.
4. **Visualisation** — load `knowledge_graph.json` into **D3.js**, **Gephi**, or **Cytoscape** for interactive graph exploration.

---

## Extensible Node/Edge Kinds System

### Adding Custom Kinds

The `core/constants.py` module provides extensible registries for node and edge kinds with metadata support.

**Register a new node kind:**
```python
from core.constants import node_registry

node_registry.register(
    key="CUSTOM_NODE",
    display_name="Custom Node",
    color="#FF5733",
    icon="star",
    layer="custom",
    description="A custom node type"
)
```

**Register a new edge kind:**
```python
from core.constants import edge_registry

edge_registry.register(
    key="CUSTOM_EDGE",
    display_name="Custom Edge",
    color="#33FF57",
    icon="arrow",
    layer="interaction",
    description="A custom edge type"
)
```

**Query kind metadata:**
```python
from core.constants import get_node_metadata, list_node_kinds

metadata = get_node_metadata("CLASS")  # Returns: {"key", "name", "color", "icon", "layer", "description"}
all_nodes = list_node_kinds(layer="java")  # List all java-layer nodes
```

### Backward Compatibility

The old `NodeKind` and `EdgeKind` class constants are auto-generated from the registry and work exactly as before:

```python
from core.constants import NodeKind, EdgeKind

kind = NodeKind.CLASS  # "Class"
edge = EdgeKind.CALLS  # "CALLS"
```

---

## Interactive Web Visualization

Visualize and explore your knowledge graph interactively using the Flask-based web dashboard.

### Starting the Visualizer

```bash
python visualizer.py --graph ./kg_output/knowledge_graph.json [--port 5000] [--host 127.0.0.1]
```

Then open your browser to `http://127.0.0.1:5000`

### Features

- **Interactive Graph Rendering** — D3.js force-directed graph with drag, zoom, and pan
- **Node Search** — Fuzzy search nodes by name or ID
- **Node Details Panel** — Inspect node metadata and neighbors (predecessors/successors)
- **Edge Relationships** — Color-coded edge types for visual differentiation
- **Statistics Dashboard** — Node/edge counts, layer breakdown, graph density
- **Tooltip Info** — Hover over nodes to see quick information
- **Label Toggle** — Show/hide node labels for cleaner graph view
- **Reset View** — Reset zoom and pan to initial state

### API Endpoints

The visualizer exposes REST endpoints for programmatic access:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/graph/data` | GET | Full graph in node-link format (D3.js compatible) |
| `/api/graph/stats` | GET | Graph statistics (node counts, edge kinds, layers, density) |
| `/api/search?q=<query>&limit=20` | GET | Fuzzy search nodes by name |
| `/api/node/<node_id>` | GET | Detailed node info with neighbors and relationships |
| `/api/path?src=<src>&dst=<dst>` | GET | Shortest path between two nodes |
| `/api/ego-graph/<node_id>?depth=1` | GET | Ego-graph (node and neighbors up to depth) |

### Requirements

Install Flask dependencies:
```bash
pip install flask flask-cors
```

Or install all reverse-engineering dependencies:
```bash
pip install -r requirements.txt
```
