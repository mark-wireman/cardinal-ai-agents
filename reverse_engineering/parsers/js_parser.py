"""
JavaScript / Node.js Parser
-----------------------------
Regex-based parser for .js / .mjs / .cjs files.
Extracts:
  • Express / Fastify / Koa / Hapi route registrations
      app.get/post/put/delete/patch/use(path, handler)
      router.get(…)
  • CommonJS require() / ES import statements
  • Class declarations (ES6)
  • Named & arrow functions
  • Middleware registrations (app.use)
  • module.exports / export assignments
  • Environment variable usage (process.env)
"""
 
from __future__ import annotations
 
import logging
import re
from pathlib import Path
 
from core.graph_store import GraphStore, NodeKind, EdgeKind
 
log = logging.getLogger("js_parser")
 
 
# ── Patterns ──────────────────────────────────────────────────────────────────
 
RE_REQUIRE   = re.compile(
    r"(?:const|let|var)\s+"
    r"(?:\{([^}]+)\}|(\w+))\s*=\s*require\s*\(\s*['\"]([^'\"]+)['\"]\s*\)"
)
RE_ES_IMPORT = re.compile(
    r"import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['\"]([^'\"]+)['\"]"
)
RE_CLASS     = re.compile(
    r"(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?"
)
RE_FUNC_DECL = re.compile(
    r"(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)"
)
RE_ARROW     = re.compile(
    r"(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>"
)
RE_METHOD    = re.compile(
    r"(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*\{"
)
# Express-style routes: app.get('/path', handler) or router.post('/path', ...)
RE_ROUTE     = re.compile(
    r"(?:app|router|server)\s*\.\s*"
    r"(get|post|put|delete|patch|use|head|options|all)\s*\("
    r"\s*['\"`]([^'\"`)]*)['\"`]"
)
RE_MIDDLEWARE = re.compile(
    r"(?:app|router)\s*\.\s*use\s*\(\s*(?:['\"`]([^'\"`)]*)['\"`]\s*,)?"
)
RE_MODULE_EXP = re.compile(
    r"module\.exports\s*=\s*(?:\{([^}]+)\}|(\w+))"
)
RE_ENV_VAR   = re.compile(r"process\.env\.(\w+)")
RE_DB_QUERY  = re.compile(
    r"(?:pool|client|db|knex|sequelize|prisma)\s*\."
    r"\s*(query|execute|run|findOne|findAll|findMany|create|update|delete|raw)\s*\("
    r"\s*['\"`]?\s*(SELECT|INSERT|UPDATE|DELETE|select|insert|update|delete)?",
    re.IGNORECASE,
)
 
 
HTTP_VERBS = {"get", "post", "put", "delete", "patch", "use", "head", "options", "all"}
 
 
class JavaScriptParser:
    def __init__(self, graph: GraphStore) -> None:
        self.graph = graph
 
    def parse(self, path: Path) -> None:
        src = path.read_text(encoding="utf-8", errors="replace")
        rel = str(path)
        mod_name = path.stem
 
        mod_id = self.graph.add_node(
            f"jsmod:{rel}", NodeKind.JS_MODULE, mod_name, "js", file=rel
        )
 
        self._parse_imports(src, rel, mod_id)
        self._parse_routes(src, rel, mod_id)
        self._parse_functions(src, rel, mod_id)
        self._parse_classes(src, rel, mod_id)
        self._parse_exports(src, rel, mod_id)
        self._parse_env_vars(src, rel, mod_id)
        self._parse_db_calls(src, rel, mod_id)
 
    # ── Imports ───────────────────────────────────────────────────────────────
 
    def _parse_imports(self, src: str, rel: str, mod_id: str) -> None:
        for m in RE_REQUIRE.finditer(src):
            names_str, single, pkg = m.groups()
            names = ([n.strip() for n in names_str.split(",") if n.strip()]
                     if names_str else [single or pkg])
            for nm in names:
                dep_id = self.graph.add_node(
                    f"dep:{pkg}#{nm}", NodeKind.DEPENDENCY, nm, "js",
                    file=rel, source_path=pkg
                )
                self.graph.add_edge(mod_id, dep_id, EdgeKind.IMPORTS)
 
        for m in RE_ES_IMPORT.finditer(src):
            names_str, single, pkg = m.groups()
            names = ([n.strip() for n in names_str.split(",") if n.strip()]
                     if names_str else [single or pkg])
            for nm in names:
                dep_id = self.graph.add_node(
                    f"dep:{pkg}#{nm}", NodeKind.DEPENDENCY, nm, "js",
                    file=rel, source_path=pkg
                )
                self.graph.add_edge(mod_id, dep_id, EdgeKind.IMPORTS)
 
    # ── Routes ────────────────────────────────────────────────────────────────
 
    def _parse_routes(self, src: str, rel: str, mod_id: str) -> None:
        for m in RE_ROUTE.finditer(src):
            verb, path_str = m.group(1).upper(), m.group(2)
            route_id = self.graph.add_node(
                f"jsroute:{verb}:{path_str}",
                NodeKind.JS_ROUTE,
                f"{verb} {path_str}",
                "js",
                file=rel,
                line=_line_of(src, m.start()),
                verb=verb,
                path=path_str,
            )
            self.graph.add_edge(mod_id, route_id, EdgeKind.HAS_METHOD)
 
        # Middleware
        for m in RE_MIDDLEWARE.finditer(src):
            mw_path = m.group(1) or "/"
            mw_id = self.graph.add_node(
                f"jsmw:{rel}:{m.start()}", NodeKind.JS_MWARE,
                f"middleware({mw_path})", "js",
                file=rel, path=mw_path
            )
            self.graph.add_edge(mod_id, mw_id, EdgeKind.HAS_METHOD)
 
    # ── Functions ─────────────────────────────────────────────────────────────
 
    def _parse_functions(self, src: str, rel: str, mod_id: str) -> None:
        for m in RE_FUNC_DECL.finditer(src):
            fname, params = m.group(1), m.group(2)
            f_id = self.graph.add_node(
                f"jsfunc:{rel}#{fname}", NodeKind.JS_FUNC, fname, "js",
                file=rel, line=_line_of(src, m.start()), params=params
            )
            self.graph.add_edge(mod_id, f_id, EdgeKind.HAS_METHOD)
            # Scan body for DB & HTTP calls
            body = _extract_block(src, m.end()) or ""
            self._scan_body_calls(body, f_id, rel)
 
        for m in RE_ARROW.finditer(src):
            fname, params = m.group(1), m.group(2)
            f_id = self.graph.add_node(
                f"jsfunc:{rel}#{fname}", NodeKind.JS_FUNC, fname, "js",
                file=rel, line=_line_of(src, m.start()), params=params
            )
            self.graph.add_edge(mod_id, f_id, EdgeKind.HAS_METHOD)
 
    # ── Classes ───────────────────────────────────────────────────────────────
 
    def _parse_classes(self, src: str, rel: str, mod_id: str) -> None:
        for m in RE_CLASS.finditer(src):
            cls_name, parent = m.group(1), m.group(2)
            cls_id = self.graph.add_node(
                f"jsclass:{rel}#{cls_name}", NodeKind.JS_CLASS, cls_name, "js",
                file=rel, line=_line_of(src, m.start())
            )
            self.graph.add_edge(mod_id, cls_id, EdgeKind.HAS_METHOD)
            if parent:
                self.graph.add_edge(cls_id, f"jsclass:{rel}#{parent}", EdgeKind.EXTENDS)
 
            body = _extract_block(src, m.end() - 1) or ""
            for mm in RE_METHOD.finditer(body):
                mname, params = mm.group(1), mm.group(2)
                if mname in ("if", "for", "while", "switch", "class"):
                    continue
                m_id = self.graph.add_node(
                    f"jsmethod:{cls_id}#{mname}", NodeKind.JS_FUNC, mname, "js",
                    file=rel, params=params
                )
                self.graph.add_edge(cls_id, m_id, EdgeKind.HAS_METHOD)
 
    # ── Exports ───────────────────────────────────────────────────────────────
 
    def _parse_exports(self, src: str, rel: str, mod_id: str) -> None:
        for m in RE_MODULE_EXP.finditer(src):
            names_str, single = m.group(1), m.group(2)
            names = ([n.strip() for n in names_str.split(",") if n.strip()]
                     if names_str else [single or "default"])
            for nm in names:
                exp_id = self.graph.add_node(
                    f"jsexport:{rel}#{nm}", NodeKind.JS_VAR, nm, "js", file=rel
                )
                self.graph.add_edge(mod_id, exp_id, EdgeKind.EXPORTS)
 
    # ── Environment variables ─────────────────────────────────────────────────
 
    def _parse_env_vars(self, src: str, rel: str, mod_id: str) -> None:
        for var_name in set(RE_ENV_VAR.findall(src)):
            env_id = self.graph.add_node(
                f"env:{var_name}", NodeKind.JS_VAR, var_name, "js",
                file=rel, is_env=True
            )
            self.graph.add_edge(mod_id, env_id, EdgeKind.DEPENDS_ON)
 
    # ── DB calls ──────────────────────────────────────────────────────────────
 
    def _parse_db_calls(self, src: str, rel: str, mod_id: str) -> None:
        for m in RE_DB_QUERY.finditer(src):
            op, sql_verb = m.group(1), m.group(2) or m.group(1)
            db_id = self.graph.add_node(
                f"dbcall:{rel}:{m.start()}", NodeKind.JS_FUNC, f"db.{op}()", "js",
                file=rel, line=_line_of(src, m.start()), db_operation=sql_verb.upper()
            )
            self.graph.add_edge(mod_id, db_id, EdgeKind.CALLS)
 
    # ── Body scan ─────────────────────────────────────────────────────────────
 
    def _scan_body_calls(self, body: str, parent_id: str, rel: str) -> None:
        for m in RE_DB_QUERY.finditer(body):
            op = m.group(1)
            db_id = self.graph.add_node(
                f"dbcall:{parent_id}:{m.start()}", NodeKind.JS_FUNC, f"db.{op}()", "js",
                file=rel, db_operation=op.upper()
            )
            self.graph.add_edge(parent_id, db_id, EdgeKind.CALLS)
 
 
# ── Helpers ───────────────────────────────────────────────────────────────────
 
def _line_of(src: str, pos: int) -> int:
    return src[:pos].count("\n") + 1
 
 
def _extract_block(src: str, start: int) -> str | None:
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