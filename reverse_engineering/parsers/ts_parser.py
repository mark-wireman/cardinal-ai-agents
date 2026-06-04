"""
TypeScript / Angular Parser
----------------------------
Regex + structural-scan based parser for .ts / .tsx files.
Extracts:
  • Angular decorators: @Component, @NgModule, @Injectable, @Directive, @Pipe
  • Classes, Interfaces, Enums, Type aliases
  • Methods, Properties, Constructor parameters (with DI)
  • Imports / Exports
  • HttpClient calls (URL strings captured)
  • Routing definitions (RouterModule.forRoot / forChild paths)
"""
 
from __future__ import annotations
 
import logging
import re
from pathlib import Path
from typing import List, Optional
 
from core.graph_store import GraphStore, NodeKind, EdgeKind
 
log = logging.getLogger("ts_parser")
 
 
# ── Compiled regex patterns ────────────────────────────────────────────────────
 
RE_IMPORT        = re.compile(
    r"import\s+(?:\{([^}]+)\}|(\w+)|(?:\*\s+as\s+(\w+)))\s+from\s+['\"]([^'\"]+)['\"]"
)
RE_CLASS         = re.compile(
    r"(?:export\s+)?(?:abstract\s+)?class\s+(\w+)"
    r"(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?"
)
RE_INTERFACE     = re.compile(r"(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+([\w,\s]+))?")
RE_ENUM          = re.compile(r"(?:export\s+)?enum\s+(\w+)")
RE_METHOD        = re.compile(
    r"(?:(?:public|private|protected|static|async|override)\s+)*"
    r"(\w+)\s*\(([^)]*)\)\s*(?::\s*([\w<>\[\]|,\s?]+))?\s*\{"
)
RE_PROPERTY      = re.compile(
    r"(?:(?:public|private|protected|static|readonly|override)\s+)+"
    r"(\w+)\s*(?:!|[?])?\s*:\s*([\w<>\[\]|,\s]+)"
)
RE_DECORATOR     = re.compile(r"@(\w+)\s*(?:\(([^)]*(?:\([^)]*\)[^)]*)*)\))?")
RE_HTTP_CALL     = re.compile(
    r"(?:this\.\w+\.)?(get|post|put|delete|patch|request)\s*(?:<[^>]*>)?\s*\(\s*['\"`]([^'\"`)]+)['\"`]"
)
RE_ROUTE_PATH    = re.compile(r"path\s*:\s*['\"`]([^'\"`)]*)['\"`]")
RE_ROUTE_COMP    = re.compile(r"component\s*:\s*(\w+)")
RE_CTOR_INJECT   = re.compile(
    r"(?:private|public|protected|readonly)\s+(\w+)\s*:\s*([\w<>]+)"
)
RE_EXPORT_FUNC   = re.compile(
    r"export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)"
    r"(?:\s*:\s*([\w<>\[\]|,\s?]+))?"
)
RE_ARROW_FUNC    = re.compile(
    r"(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)"
    r"(?:\s*:\s*([\w<>\[\]|,\s?]+))?\s*=>"
)
 
 
ANG_DECORATOR_KINDS = {
    "Component":   NodeKind.COMPONENT,
    "Injectable":  NodeKind.SERVICE,
    "NgModule":    NodeKind.MODULE,
    "Directive":   NodeKind.DIRECTIVE,
    "Pipe":        NodeKind.PIPE,
}
 
 
class TypeScriptParser:
    def __init__(self, graph: GraphStore) -> None:
        self.graph = graph
 
    # ── Public ────────────────────────────────────────────────────────────────
 
    def parse(self, path: Path) -> None:
        src   = path.read_text(encoding="utf-8", errors="replace")
        lines = src.splitlines()
        rel   = str(path)
 
        # Build a line-by-line decorator map first
        dec_map = _build_decorator_map(lines)
 
        # Imports
        imports = self._parse_imports(src, rel)
 
        # Top-level functions (not inside a class)
        self._parse_top_level_functions(src, lines, rel, path.stem)
 
        # Classes / Interfaces / Enums
        for m in RE_CLASS.finditer(src):
            self._process_class(m, src, lines, dec_map, rel, imports, path)
 
        for m in RE_INTERFACE.finditer(src):
            iface_name = m.group(1)
            iface_id   = f"tsiface:{rel}#{iface_name}"
            extends    = [e.strip() for e in (m.group(2) or "").split(",") if e.strip()]
            self.graph.add_node(iface_id, NodeKind.TS_IFACE, iface_name, "ts",
                                 file=rel, line=_line_of(src, m.start()))
            for ext in extends:
                self.graph.add_edge(iface_id, f"tsiface:{rel}#{ext}", EdgeKind.EXTENDS)
 
        for m in RE_ENUM.finditer(src):
            enum_name = m.group(1)
            enum_id   = f"tsenum:{rel}#{enum_name}"
            self.graph.add_node(enum_id, NodeKind.TS_ENUM, enum_name, "ts",
                                 file=rel, line=_line_of(src, m.start()))
 
        # HTTP calls (module-level)
        self._parse_http_calls(src, rel)
 
    # ── Imports ───────────────────────────────────────────────────────────────
 
    def _parse_imports(self, src: str, rel: str) -> List[str]:
        imported: List[str] = []
        for m in RE_IMPORT.finditer(src):
            names_str, default_nm, star_nm, from_path = m.groups()
            names = []
            if names_str:
                names = [n.strip() for n in names_str.split(",") if n.strip()]
            elif default_nm:
                names = [default_nm]
            elif star_nm:
                names = [star_nm]
            for nm in names:
                imp_id = f"dep:{from_path}#{nm}"
                self.graph.add_node(imp_id, NodeKind.DEPENDENCY, nm, "ts",
                                     file=rel, source_path=from_path)
                imported.append(nm)
        return imported
 
    # ── Class ─────────────────────────────────────────────────────────────────
 
    def _process_class(self, m, src: str, lines: List[str],
                        dec_map: dict, rel: str,
                        imports: List[str], path: Path) -> None:
        cls_name  = m.group(1)
        cls_start = m.start()
        cls_line  = _line_of(src, cls_start)
 
        # Determine Angular kind from decorator
        dec_list  = dec_map.get(cls_line, [])
        ang_kind  = next(
            (ANG_DECORATOR_KINDS[d["name"]] for d in dec_list
             if d["name"] in ANG_DECORATOR_KINDS),
            NodeKind.TS_CLASS,
        )
 
        # Decorator metadata
        selector    = _dec_attr(dec_list, "Component",  "selector")
        template    = _dec_attr(dec_list, "Component",  "templateUrl")
        module_imp  = _dec_attr(dec_list, "NgModule",   "imports")
 
        cls_id = f"tsclass:{rel}#{cls_name}"
        self.graph.add_node(
            cls_id, ang_kind, cls_name, "ts",
            file=rel, line=cls_line,
            selector=selector or "", template=template or "",
            angular_kind=ang_kind,
        )
 
        # Inheritance / implements
        parent = m.group(2)
        if parent:
            self.graph.add_edge(cls_id, f"tsclass:{rel}#{parent}", EdgeKind.EXTENDS)
        for iface in [i.strip() for i in (m.group(3) or "").split(",") if i.strip()]:
            self.graph.add_edge(cls_id, f"tsiface:{rel}#{iface}", EdgeKind.IMPLEMENTS)
 
        # Decorator nodes
        for dec in dec_list:
            d_id = self.graph.add_node(f"dec:{dec['name']}", NodeKind.ANNOTATION,
                                        dec["name"], "ts")
            self.graph.add_edge(cls_id, d_id, EdgeKind.ANNOTATED_WITH)
 
        # Class body
        body = _extract_block(src, m.end() - 1)
        if not body:
            return
 
        self._parse_constructor(body, cls_id, rel, cls_line)
        self._parse_properties(body, cls_id, rel)
        self._parse_methods(body, cls_id, cls_name, rel, path)
 
    # ── Constructor (DI) ──────────────────────────────────────────────────────
 
    def _parse_constructor(self, body: str, cls_id: str, rel: str, cls_line: int) -> None:
        ctor_m = re.search(r"constructor\s*\(([^)]*)\)", body)
        if not ctor_m:
            return
        params_str = ctor_m.group(1)
        for pm in RE_CTOR_INJECT.finditer(params_str):
            param_name, param_type = pm.group(1), pm.group(2)
            # Add DI edge to the injected service
            self.graph.add_edge(cls_id, f"tsclass:*#{param_type}", EdgeKind.INJECTS)
 
    # ── Properties ────────────────────────────────────────────────────────────
 
    def _parse_properties(self, body: str, cls_id: str, rel: str) -> None:
        for m in RE_PROPERTY.finditer(body):
            prop_name, prop_type = m.group(1), m.group(2).strip()
            if prop_name in ("constructor", "return", "if", "for", "while"):
                continue
            p_id = f"tsprop:{cls_id}#{prop_name}"
            self.graph.add_node(p_id, NodeKind.TS_PROP, prop_name, "ts",
                                 file=rel, prop_type=prop_type)
            self.graph.add_edge(cls_id, p_id, EdgeKind.HAS_FIELD)
 
    # ── Methods ───────────────────────────────────────────────────────────────
 
    def _parse_methods(self, body: str, cls_id: str, cls_name: str,
                        rel: str, path: Path) -> None:
        for m in RE_METHOD.finditer(body):
            mname, params, rtype = m.group(1), m.group(2), m.group(3) or ""
            if mname in ("if", "for", "while", "switch", "catch", "class",
                          "function", "return", "constructor"):
                continue
            m_id = f"tsmethod:{cls_id}#{mname}"
 
            # Detect HTTP calls inside method body
            method_body = _extract_block(body, m.end() - 1) or ""
            http_calls  = RE_HTTP_CALL.findall(method_body)
            http_url    = http_calls[0][1] if http_calls else ""
 
            self.graph.add_node(
                m_id, NodeKind.TS_METHOD, mname, "ts",
                file=rel, params=params, return_type=rtype.strip(),
                http_url=http_url,
            )
            self.graph.add_edge(cls_id, m_id, EdgeKind.HAS_METHOD)
 
            # Route path associations (for routing modules)
            for route_path in RE_ROUTE_PATH.findall(method_body):
                route_id = f"route:{rel}#{route_path}"
                self.graph.add_node(route_id, NodeKind.JS_ROUTE, route_path, "ts",
                                     file=rel, path=route_path)
                self.graph.add_edge(m_id, route_id, EdgeKind.ROUTES_TO)
 
    # ── Top-level functions ───────────────────────────────────────────────────
 
    def _parse_top_level_functions(self, src: str, lines: list,
                                    rel: str, module_name: str) -> None:
        mod_id = f"tsmod:{rel}"
        self.graph.add_node(mod_id, NodeKind.JS_MODULE, module_name, "ts", file=rel)
 
        for m in RE_EXPORT_FUNC.finditer(src):
            fname, params, rtype = m.group(1), m.group(2), m.group(3) or ""
            f_id = f"tsfunc:{rel}#{fname}"
            self.graph.add_node(f_id, NodeKind.TS_FUNC, fname, "ts",
                                 file=rel, line=_line_of(src, m.start()),
                                 params=params, return_type=rtype.strip())
            self.graph.add_edge(mod_id, f_id, EdgeKind.EXPORTS)
 
        for m in RE_ARROW_FUNC.finditer(src):
            fname, params, rtype = m.group(1), m.group(2), m.group(3) or ""
            f_id = f"tsfunc:{rel}#{fname}"
            self.graph.add_node(f_id, NodeKind.TS_FUNC, fname, "ts",
                                 file=rel, line=_line_of(src, m.start()),
                                 params=params, return_type=rtype.strip())
            self.graph.add_edge(mod_id, f_id, EdgeKind.EXPORTS)
 
    # ── HTTP calls ────────────────────────────────────────────────────────────
 
    def _parse_http_calls(self, src: str, rel: str) -> None:
        for verb, url in RE_HTTP_CALL.findall(src):
            ep_id = f"endpoint:{verb.upper()}:{url}"
            self.graph.add_node(ep_id, NodeKind.ENDPOINT, url, "ts",
                                 file=rel, verb=verb.upper(), url=url)
 
 
# ── Helpers ───────────────────────────────────────────────────────────────────
 
def _line_of(src: str, pos: int) -> int:
    return src[:pos].count("\n") + 1
 
 
def _build_decorator_map(lines: List[str]) -> dict:
    """Build a map from class-start line number to list of decorators above it."""
    dec_map = {}
    pending = []
    non_class_decl = re.compile(
        r"^(?:export\s+)?(?:function|interface|enum|const|let|var|type|import)\b"
    )

    for i, line in enumerate(lines, 1):
        stripped = line.strip()

        for dm in RE_DECORATOR.finditer(stripped):
            pending.append({"name": dm.group(1), "args": dm.group(2) or ""})

        if RE_CLASS.search(stripped):
            if pending:
                dec_map[i] = pending[:]
                pending = []
            continue

        if not pending or not stripped or stripped.startswith("//"):
            continue

        if non_class_decl.search(stripped):
            pending = []

    return dec_map
 
 
def _dec_attr(dec_list: list, dec_name: str, attr: str) -> Optional[str]:
    for d in dec_list:
        if d["name"] == dec_name:
            m = re.search(rf"{attr}\s*:\s*['\"`]?([^'\"`,\)\n]+)", d["args"])
            if m:
                return m.group(1).strip().strip("'\"` ")
    return None
 
 
def _extract_block(src: str, start: int) -> Optional[str]:
    """Extract balanced { } block starting at `start` index."""
    depth = 0
    i     = start
    begin = None
    while i < len(src):
        c = src[i]
        if c == "{":
            if begin is None:
                begin = i
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0 and begin is not None:
                return src[begin + 1:i]
        i += 1
    return None