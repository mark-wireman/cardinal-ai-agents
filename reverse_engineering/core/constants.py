"""
Extensible Node and Edge Kind Registries
-----------------------------------------
Provides registries for dynamically adding node/edge kinds with metadata support.
"""

from typing import Dict, Any, List, Optional


class KindRegistry:
    """Base registry for extensible kinds with metadata."""
    
    def __init__(self, category: str):
        self.category = category
        self._kinds: Dict[str, Dict[str, Any]] = {}
    
    def register(self, key: str, display_name: str, color: str = "#999999",
                 icon: str = "circle", layer: str = "unknown", 
                 description: str = "") -> None:
        """Register a new kind with metadata."""
        self._kinds[key] = {
            "key": key,
            "name": display_name,
            "color": color,
            "icon": icon,
            "layer": layer,
            "description": description,
        }
    
    def get(self, key: str) -> Optional[Dict[str, Any]]:
        """Retrieve metadata for a kind."""
        return self._kinds.get(key)
    
    def all(self) -> Dict[str, Dict[str, Any]]:
        """Get all registered kinds."""
        return self._kinds.copy()
    
    def as_class(self) -> type:
        """Convert registry to a class with constants for backwards compatibility."""
        attrs = {key: data["key"] for key, data in self._kinds.items()}
        return type(f"{self.category}Kind", (), attrs)


# ── Initialize Registries ───────────────────────────────────────────────────

node_registry = KindRegistry("Node")
edge_registry = KindRegistry("Edge")

# ── Register Java/Spring Nodes ──────────────────────────────────────────────

node_registry.register("CLASS", "Class", "#4A90E2", "cube", "java",
                       "Java class or Spring stereotype class")
node_registry.register("INTERFACE", "Interface", "#50C878", "diamond", "java",
                       "Java interface definition")
node_registry.register("ENUM", "Enum", "#FFB347", "hexagon", "java",
                       "Java enum type")
node_registry.register("ANNOTATION", "Annotation", "#FF6B9D", "star", "java",
                       "Java annotation")
node_registry.register("METHOD", "Method", "#9B59B6", "function", "java",
                       "Java method or function")
node_registry.register("FIELD", "Field", "#3498DB", "square", "java",
                       "Java field or @Column")
node_registry.register("CONSTRUCTOR", "Constructor", "#E74C3C", "function", "java",
                       "Java constructor")
node_registry.register("PACKAGE", "Package", "#F39C12", "folder", "java",
                       "Java package")

# ── Register TypeScript/Angular Nodes ───────────────────────────────────────

node_registry.register("COMPONENT", "Component", "#1E90FF", "cube", "ts",
                       "Angular @Component")
node_registry.register("SERVICE", "Service", "#32CD32", "settings", "ts",
                       "Angular @Injectable service")
node_registry.register("MODULE", "Module", "#FF8C00", "folder", "ts",
                       "Angular @NgModule")
node_registry.register("DIRECTIVE", "Directive", "#9370DB", "wand", "ts",
                       "Angular @Directive")
node_registry.register("PIPE", "Pipe", "#20B2AA", "pipeline", "ts",
                       "Angular @Pipe")
node_registry.register("TS_CLASS", "TsClass", "#4A90E2", "cube", "ts",
                       "Plain TypeScript class")
node_registry.register("TS_IFACE", "TsInterface", "#50C878", "diamond", "ts",
                       "TypeScript interface")
node_registry.register("TS_ENUM", "TsEnum", "FFB347", "hexagon", "ts",
                       "TypeScript enum")
node_registry.register("TS_METHOD", "TsMethod", "#9B59B6", "function", "ts",
                       "TypeScript method")
node_registry.register("TS_PROP", "TsProperty", "#3498DB", "square", "ts",
                       "TypeScript property")
node_registry.register("TS_FUNC", "TsFunction", "#E67E22", "function", "ts",
                       "TypeScript function")

# ── Register JavaScript/Node.js Nodes ──────────────────────────────────────

node_registry.register("JS_FUNC", "JsFunction", "#E67E22", "function", "js",
                       "JavaScript function")
node_registry.register("JS_CLASS", "JsClass", "#4A90E2", "cube", "js",
                       "JavaScript class")
node_registry.register("JS_VAR", "JsVariable", "#3498DB", "variable", "js",
                       "JavaScript variable")
node_registry.register("JS_ROUTE", "JsRoute", "#16A085", "route", "js",
                       "Express route handler")
node_registry.register("JS_MWARE", "JsMiddleware", "#8E44AD", "middleware", "js",
                       "Express middleware")
node_registry.register("JS_MODULE", "JsModule", "#F39C12", "folder", "js",
                       "Node.js module")

# ── Register SQL/PostgreSQL Nodes ──────────────────────────────────────────

node_registry.register("TABLE", "Table", "#E74C3C", "database", "sql",
                       "PostgreSQL table")
node_registry.register("COLUMN", "Column", "#3498DB", "field", "sql",
                       "Table column with type/constraints")
node_registry.register("INDEX", "Index", "#F39C12", "index", "sql",
                       "Database index")
node_registry.register("VIEW", "View", "#9B59B6", "eye", "sql",
                       "SQL view")
node_registry.register("SEQUENCE", "Sequence", "#16A085", "sequence", "sql",
                       "PostgreSQL sequence")
node_registry.register("FOREIGN_KEY", "ForeignKey", "#C0392B", "link", "sql",
                       "Foreign key constraint")

# ── Register Cross-Layer Nodes ──────────────────────────────────────────────

node_registry.register("ENDPOINT", "Endpoint", "#E74C3C", "globe", "cross",
                       "HTTP endpoint resolved across layers")
node_registry.register("DEPENDENCY", "Dependency", "#95A5A6", "package", "cross",
                       "External dependency or import")

# ── Register Edge Types ─────────────────────────────────────────────────────

edge_registry.register("EXTENDS", "Extends", "#2E86DE", "arrow",
                       "inheritance", "Direct inheritance relationship")
edge_registry.register("IMPLEMENTS", "Implements", "#A29BFE", "arrow",
                       "inheritance", "Interface implementation")
edge_registry.register("HAS_METHOD", "HasMethod", "#6C5CE7", "containment",
                       "structure", "Class contains method")
edge_registry.register("HAS_FIELD", "HasField", "#74B9FF", "containment",
                       "structure", "Class contains field")
edge_registry.register("HAS_COLUMN", "HasColumn", "#00B894", "containment",
                       "structure", "Table contains column")
edge_registry.register("CALLS", "Calls", "#E17055", "arrow",
                       "interaction", "Direct method/function call")
edge_registry.register("RETURNS", "Returns", "#74B9FF", "dotted",
                       "interaction", "Return type relationship")
edge_registry.register("IMPORTS", "Imports", "#0984E3", "arrow",
                       "dependency", "Module import")
edge_registry.register("ANNOTATED_WITH", "AnnotatedWith", "#FF7675", "label",
                       "annotation", "Applies annotation")
edge_registry.register("INJECTS", "Injects", "#D63031", "arrow",
                       "dependency", "Dependency injection (DI)")
edge_registry.register("MAPS_TO", "MapsTo", "#00B894", "arrow",
                       "mapping", "JPA entity maps to table")
edge_registry.register("ROUTES_TO", "RoutesTo", "#FDCB6E", "arrow",
                       "mapping", "Route maps to controller method")
edge_registry.register("REFERENCES", "References", "#00CEC9", "arrow",
                       "constraint", "FK column references table")
edge_registry.register("BELONGS_TO", "BelongsTo", "#6C5CE7", "arrow",
                       "ownership", "Element belongs to parent")
edge_registry.register("USES_TYPE", "UsesType", "#74B9FF", "dotted",
                       "interaction", "Uses or depends on type")
edge_registry.register("HAS_INDEX", "HasIndex", "#F39C12", "containment",
                       "structure", "Table has index")
edge_registry.register("EXPORTS", "Exports", "#27AE60", "arrow",
                       "interaction", "Module exports symbol")
edge_registry.register("PROVIDES", "Provides", "#E8B71A", "arrow",
                       "dependency", "Angular provider supplied by module")
edge_registry.register("DEPENDS_ON", "DependsOn", "#95A5A6", "dotted",
                       "dependency", "Generic dependency relationship")

# ── Register CSS / SCSS / LESS Nodes ───────────────────────────────────────

node_registry.register("STYLESHEET", "Stylesheet", "#2563EB", "file", "css",
                       "CSS/SCSS/LESS stylesheet file")
node_registry.register("CSS_CLASS", "CssClass", "#3B82F6", "tag", "css",
                       "CSS class selector (.foo)")
node_registry.register("CSS_ID_SELECTOR", "CssIdSelector", "#7C3AED", "tag", "css",
                       "CSS ID selector (#foo)")
node_registry.register("CSS_ELEMENT", "CssElement", "#0891B2", "tag", "css",
                       "CSS element/tag selector (div, span, …)")
node_registry.register("CSS_VARIABLE", "CssVariable", "#059669", "variable", "css",
                       "CSS custom property (--my-var) or SCSS variable ($var)")
node_registry.register("CSS_MEDIA", "CssMedia", "#D97706", "screen", "css",
                       "CSS @media query block")
node_registry.register("CSS_KEYFRAME", "CssKeyframe", "#EC4899", "animate", "css",
                       "CSS @keyframes animation")
node_registry.register("CSS_IMPORT", "CssImport", "#6366F1", "import", "css",
                       "CSS @import reference")
node_registry.register("CSS_MIXIN", "CssMixin", "#8B5CF6", "function", "css",
                       "SCSS @mixin definition")

# ── Register HTML / Angular Template Nodes ─────────────────────────────────

node_registry.register("HTML_DOCUMENT", "HtmlDocument", "#EA580C", "file", "html",
                       "HTML template or document file")
node_registry.register("HTML_ELEMENT", "HtmlElement", "#F97316", "tag", "html",
                       "Standard HTML element (div, span, button, …)")
node_registry.register("HTML_COMPONENT", "HtmlComponent", "#EC4899", "cube", "html",
                       "Angular component used as custom element (<app-foo>)")
node_registry.register("HTML_FORM", "HtmlForm", "#10B981", "form", "html",
                       "HTML <form> element with action/method")
node_registry.register("HTML_LINK", "HtmlLink", "#06B6D4", "link", "html",
                       "HTML <a> hyperlink")
node_registry.register("HTML_SCRIPT", "HtmlScript", "#EAB308", "code", "html",
                       "HTML <script src=…> import")
node_registry.register("HTML_ID", "HtmlId", "#7C3AED", "id", "html",
                       "HTML element id attribute value")
node_registry.register("HTML_CLASS_REF", "HtmlClassRef", "#2563EB", "tag", "html",
                       "CSS class referenced from HTML class attribute")
node_registry.register("HTML_DIRECTIVE", "HtmlDirective", "#6366F1", "wand", "html",
                       "Angular structural directive (*ngIf, *ngFor, routerLink, …)")
node_registry.register("HTML_BINDING", "HtmlBinding", "#8B5CF6", "binding", "html",
                       "Angular template binding or interpolation")

# ── Register CSS/HTML-specific Edge Types ──────────────────────────────────

edge_registry.register("HAS_RULE", "HasRule", "#3B82F6", "containment",
                       "structure", "Stylesheet contains CSS rule/selector")
edge_registry.register("DEFINES", "Defines", "#10B981", "arrow",
                       "structure", "Stylesheet defines variable/mixin")
edge_registry.register("LINKS_TO", "LinksTo", "#06B6D4", "arrow",
                       "interaction", "HTML element links to resource")
edge_registry.register("INCLUDES", "Includes", "#F59E0B", "arrow",
                       "dependency", "HTML document includes script/resource")
edge_registry.register("USES_CLASS", "UsesClass", "#6366F1", "dotted",
                       "interaction", "HTML element references CSS class")
edge_registry.register("USES_COMPONENT", "UsesComponent", "#EC4899", "arrow",
                       "interaction", "HTML template uses Angular component")
edge_registry.register("USES_DIRECTIVE", "UsesDirective", "#8B5CF6", "arrow",
                       "interaction", "HTML template uses Angular directive")
edge_registry.register("HAS_ELEMENT", "HasElement", "#F97316", "containment",
                       "structure", "HTML document contains element")
edge_registry.register("BINDS", "Binds", "#A855F7", "arrow",
                       "interaction", "Angular template data or event binding")

# ── Create backwards-compatible NodeKind and EdgeKind classes ──────────────

NodeKind = node_registry.as_class()
EdgeKind = edge_registry.as_class()


def get_node_metadata(kind: str) -> Optional[Dict[str, Any]]:
    """Get metadata for a node kind."""
    return node_registry.get(kind)


def get_edge_metadata(kind: str) -> Optional[Dict[str, Any]]:
    """Get metadata for an edge kind."""
    return edge_registry.get(kind)


def list_node_kinds(layer: Optional[str] = None) -> List[Dict[str, Any]]:
    """List all node kinds, optionally filtered by layer."""
    all_nodes = list(node_registry.all().values())
    if layer:
        return [n for n in all_nodes if n["layer"] == layer]
    return all_nodes


def list_edge_kinds() -> List[Dict[str, Any]]:
    """List all edge kinds."""
    return list(edge_registry.all().values())
