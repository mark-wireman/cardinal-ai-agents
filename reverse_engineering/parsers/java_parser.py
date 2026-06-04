"""
Java / Spring Boot Parser
--------------------------
Uses `javalang` to parse .java source files and extract:
  • Packages, Classes, Interfaces, Enums, Annotations
  • Fields (with type, visibility, Spring annotations)
  • Methods / Constructors (signatures, return types, parameters)
  • Imports
  • Spring-specific metadata:
      @Entity / @Table   → marks class as JPA entity, records table name
      @RestController    → HTTP controller
      @RequestMapping / @GetMapping / @PostMapping … → HTTP routes
      @Autowired / @Inject / constructor injection → DI edges
      @Service / @Repository / @Component           → stereotype
"""
 
from __future__ import annotations
 
import logging
import re
from pathlib import Path
from typing  import Optional
 
log = logging.getLogger("java_parser")
 
try:
    import javalang
    JAVALANG_OK = True
except ImportError:
    JAVALANG_OK = False
    log.warning("javalang not installed — using best-effort Java fallback parser. Run: pip install javalang for full AST support")
 
from core.graph_store import GraphStore, NodeKind, EdgeKind
 
 
# HTTP method annotations → verb
MAPPING_VERBS = {
    "RequestMapping": "ANY",
    "GetMapping":     "GET",
    "PostMapping":    "POST",
    "PutMapping":     "PUT",
    "DeleteMapping":  "DELETE",
    "PatchMapping":   "PATCH",
}
 
SPRING_STEREOTYPES = {"Service", "Repository", "Component", "RestController",
                      "Controller", "Configuration", "SpringBootApplication"}

RE_PACKAGE = re.compile(r"^\s*package\s+([\w.]+)\s*;", re.MULTILINE)
RE_IMPORT = re.compile(r"^\s*import\s+(?:static\s+)?([\w.*]+)\s*;", re.MULTILINE)
MODIFIERS = r"(?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp|native|synchronized|default|transient|volatile)"
RE_TYPE_DECL = re.compile(
    r"((?:\s*@(?:[\w.]+)(?:\([^)]*\))?\s*)*)"
    rf"(?:{MODIFIERS}\s+)*"
    r"\b(class|interface|enum|record)\s+(\w+)"
    r"(?:\s*\([^)]*\))?"
    r"(?:\s+extends\s+([\w.<>]+))?"
    r"(?:\s+implements\s+([\w<>,.\s]+))?\s*\{",
    re.MULTILINE,
)
RE_FIELD_STMT = re.compile(
    r"((?:\s*@(?:[\w.]+)(?:\([^)]*\))?\s*)*)"
    rf"(?:{MODIFIERS}\s+)*"
    r"([\w<>\[\].?,]+)\s+(\w+)(?:\s*=.*)?$",
    re.DOTALL,
)
RE_METHOD_HEADER = re.compile(
    r"((?:\s*@(?:[\w.]+)(?:\([^)]*\))?\s*)*)"
    rf"(?:{MODIFIERS}\s+)*"
    r"(?:<[^>]+>\s+)?([\w<>\[\].?,]+)\s+(\w+)\s*\(([^)]*)\)"
    r"(?:\s+throws\s+[^{]+)?$",
    re.DOTALL,
)
RE_CTOR_HEADER = re.compile(
    r"((?:\s*@(?:[\w.]+)(?:\([^)]*\))?\s*)*)"
    rf"(?:{MODIFIERS}\s+)*"
    r"(\w+)\s*\(([^)]*)\)"
    r"(?:\s+throws\s+[^{]+)?$",
    re.DOTALL,
)
 
 
class JavaParser:
    def __init__(self, graph: GraphStore) -> None:
        self.graph = graph
 
    # ── Public ────────────────────────────────────────────────────────────────
 
    def parse(self, path: Path) -> None:
        source = path.read_text(encoding="utf-8", errors="replace")

        if not JAVALANG_OK:
            self._parse_fallback(source, path)
            return
        try:
            tree = javalang.parse.parse(source)
        except Exception as exc:
            log.debug(f"javalang parse error {path}: {exc}")
            self._parse_fallback(source, path)
            return
 
        pkg = _package_name(tree)
        self._process_imports(tree, pkg, path)
 
        for _, type_decl in tree.filter(javalang.tree.TypeDeclaration):
            self._process_type(type_decl, pkg, path)

    def _parse_fallback(self, source: str, path: Path) -> None:
        cleaned = _strip_java_comments(source)
        pkg = _package_name_from_text(cleaned)
        pkg_id = self.graph.add_node(f"pkg:{pkg}", NodeKind.PACKAGE, pkg, "java", file=str(path))

        for imp in RE_IMPORT.findall(cleaned):
            imp_id = self.graph.add_node(f"import:{imp}", NodeKind.DEPENDENCY, imp, "java", file=str(path))
            self.graph.add_edge(pkg_id, imp_id, EdgeKind.IMPORTS)

        for decl in _extract_type_blocks(cleaned):
            self._process_fallback_type(decl, pkg, path)
 
    # ── Imports ───────────────────────────────────────────────────────────────
 
    def _process_imports(self, tree, pkg: str, path: Path) -> None:
        pkg_id = self.graph.add_node(f"pkg:{pkg}", NodeKind.PACKAGE, pkg, "java",
                                     file=str(path))
        for imp in (tree.imports or []):
            imp_id = self.graph.add_node(f"import:{imp.path}", NodeKind.DEPENDENCY,
                                          imp.path, "java", file=str(path))
            self.graph.add_edge(pkg_id, imp_id, EdgeKind.IMPORTS)
 
    # ── Type declarations ─────────────────────────────────────────────────────
 
    def _process_type(self, decl, pkg: str, path: Path) -> None:
        if isinstance(decl, javalang.tree.ClassDeclaration):
            self._process_class(decl, pkg, path)
        elif isinstance(decl, javalang.tree.InterfaceDeclaration):
            self._process_interface(decl, pkg, path)
        elif isinstance(decl, javalang.tree.EnumDeclaration):
            self._process_enum(decl, pkg, path)
        elif isinstance(decl, javalang.tree.AnnotationDeclaration):
            fqn = f"{pkg}.{decl.name}"
            self.graph.add_node(f"class:{fqn}", NodeKind.ANNOTATION, decl.name,
                                 "java", file=str(path))
 
    def _process_class(self, cls, pkg: str, path: Path) -> None:
        fqn    = f"{pkg}.{cls.name}"
        cls_id = f"class:{fqn}"
 
        annotations     = _annotation_names(cls)
        stereotype      = next((a for a in annotations if a in SPRING_STEREOTYPES), None)
        is_entity       = "Entity" in annotations
        is_controller   = any(a in ("RestController", "Controller") for a in annotations)
        table_name      = _annotation_attr(cls, "Table", "name") or ""
        class_http_path = (_annotation_attr(cls, "RequestMapping", "value")
                           or _annotation_attr(cls, "RequestMapping", "path") or "")
 
        self.graph.add_node(
            cls_id, NodeKind.CLASS, cls.name, "java",
            file=str(path), line=cls.position.line if cls.position else -1,
            fqn=fqn, package=pkg,
            is_entity=is_entity, is_controller=is_controller,
            stereotype=stereotype or "",
            table_name=table_name,
        )
 
        # Inheritance / implements
        if cls.extends:
            parent = _type_to_str(cls.extends)
            self.graph.add_edge(cls_id, f"class:{pkg}.{parent}", EdgeKind.EXTENDS)
 
        for iface in (cls.implements or []):
            iface_name = _type_to_str(iface)
            self.graph.add_edge(cls_id, f"iface:{pkg}.{iface_name}", EdgeKind.IMPLEMENTS)
 
        # Annotation edges
        for ann in annotations:
            ann_id = self.graph.add_node(f"ann:{ann}", NodeKind.ANNOTATION, ann, "java")
            self.graph.add_edge(cls_id, ann_id, EdgeKind.ANNOTATED_WITH)
 
        # Fields
        for field_decl in (cls.fields or []):
            self._process_field(field_decl, cls_id, pkg, path)
 
        # Constructors
        for ctor in (cls.constructors or []):
            self._process_constructor(ctor, cls_id, cls.name, pkg, path)
 
        # Methods
        for method in (cls.methods or []):
            self._process_method(method, cls_id, fqn, class_http_path, is_controller, pkg, path)
 
    def _process_interface(self, iface, pkg: str, path: Path) -> None:
        fqn      = f"{pkg}.{iface.name}"
        iface_id = f"iface:{fqn}"
        self.graph.add_node(iface_id, NodeKind.INTERFACE, iface.name, "java",
                             file=str(path), fqn=fqn, package=pkg)
        for ext in (iface.extends or []):
            self.graph.add_edge(iface_id, f"iface:{pkg}.{_type_to_str(ext)}", EdgeKind.EXTENDS)
        for method in (iface.methods or []):
            m_id = f"method:{fqn}.{method.name}"
            self.graph.add_node(m_id, NodeKind.METHOD, method.name, "java",
                                 file=str(path), return_type=_type_to_str(method.return_type))
            self.graph.add_edge(iface_id, m_id, EdgeKind.HAS_METHOD)
 
    def _process_enum(self, enum, pkg: str, path: Path) -> None:
        fqn     = f"{pkg}.{enum.name}"
        enum_id = f"class:{fqn}"
        constants = [c.name for c in (enum.body.constants or [])]
        self.graph.add_node(enum_id, NodeKind.ENUM, enum.name, "java",
                             file=str(path), fqn=fqn, constants=",".join(constants))
 
    # ── Fields ────────────────────────────────────────────────────────────────
 
    def _process_field(self, field_decl, cls_id: str, pkg: str, path: Path) -> None:
        field_type = _type_to_str(field_decl.type)
        ann_names  = _annotation_names(field_decl)
        is_injected = any(a in ("Autowired", "Inject", "Value") for a in ann_names)
        is_column   = "Column" in ann_names
 
        for declarator in field_decl.declarators:
            f_id = f"field:{cls_id}#{declarator.name}"
            self.graph.add_node(
                f_id, NodeKind.FIELD, declarator.name, "java",
                file=str(path),
                field_type=field_type,
                modifiers=",".join(field_decl.modifiers or []),
                is_injected=is_injected,
                column_name=_annotation_attr(field_decl, "Column", "name") or "",
            )
            self.graph.add_edge(cls_id, f_id, EdgeKind.HAS_FIELD)
            if is_injected:
                # Try to link to a known service/repo type
                self.graph.add_edge(cls_id, f"class:{pkg}.{field_type}", EdgeKind.INJECTS)
 
    # ── Constructors ──────────────────────────────────────────────────────────
 
    def _process_constructor(self, ctor, cls_id: str, cls_name: str, pkg: str, path: Path) -> None:
        params    = _params_str(ctor.parameters)
        ctor_id   = f"ctor:{cls_id}({params})"
        self.graph.add_node(ctor_id, NodeKind.CONSTRUCTOR, f"{cls_name}()", "java",
                             file=str(path), params=params)
        self.graph.add_edge(cls_id, ctor_id, EdgeKind.HAS_METHOD)
        # Constructor injection
        for param in (ctor.parameters or []):
            p_type = _type_to_str(param.type)
            self.graph.add_edge(cls_id, f"class:{pkg}.{p_type}", EdgeKind.INJECTS)
 
    # ── Methods ───────────────────────────────────────────────────────────────
 
    def _process_method(self, method, cls_id: str, fqn: str,
                         class_path: str, is_controller: bool,
                         pkg: str, path: Path) -> None:
        ann_names   = _annotation_names(method)
        params      = _params_str(method.parameters)
        return_type = _type_to_str(method.return_type)
        m_id        = f"method:{fqn}.{method.name}({params})"
 
        # HTTP route metadata
        http_verb = http_path = ""
        for ann, verb in MAPPING_VERBS.items():
            if ann in ann_names:
                http_verb = verb
                raw_path  = (_annotation_attr(method, ann, "value")
                             or _annotation_attr(method, ann, "path") or "")
                http_path = f"{class_path}/{raw_path}".replace("//", "/")
                break
 
        self.graph.add_node(
            m_id, NodeKind.METHOD, method.name, "java",
            file=str(path), line=method.position.line if method.position else -1,
            return_type=return_type, params=params,
            modifiers=",".join(method.modifiers or []),
            http_verb=http_verb, http_path=http_path,
            is_http_handler=bool(http_verb),
        )
        self.graph.add_edge(cls_id, m_id, EdgeKind.HAS_METHOD)
 
        # Return type edge
        if return_type and return_type not in ("void", "String", "int", "long",
                                                "boolean", "double", "float"):
            self.graph.add_edge(m_id, f"class:{pkg}.{return_type}", EdgeKind.RETURNS)
 
        # Method invocations (best-effort via javalang)
        if method.body:
            for _, inv in method.filter(javalang.tree.MethodInvocation):
                self.graph.add_edge(m_id, f"method_ref:{inv.member}", EdgeKind.CALLS)

    def _process_fallback_type(self, decl: dict, pkg: str, path: Path) -> None:
        kind = decl["kind"]
        name = decl["name"]
        annotations = decl["annotations"]
        ann_block = decl["annotation_block"]
        fqn = f"{pkg}.{name}"

        if kind in {"class", "record"}:
            cls_id = f"class:{fqn}"
            stereotype = next((a for a in annotations if a in SPRING_STEREOTYPES), None)
            is_entity = "Entity" in annotations
            is_controller = any(a in ("RestController", "Controller") for a in annotations)
            table_name = _annotation_attr_from_text(ann_block, "Table", "name") or ""
            class_http_path = (
                _annotation_attr_from_text(ann_block, "RequestMapping", "value")
                or _annotation_attr_from_text(ann_block, "RequestMapping", "path")
                or ""
            )

            self.graph.add_node(
                cls_id, NodeKind.CLASS, name, "java",
                file=str(path), fqn=fqn, package=pkg,
                is_entity=is_entity, is_controller=is_controller,
                stereotype=stereotype or "", table_name=table_name,
                is_record=(kind == "record"),
            )

            if decl.get("extends"):
                self.graph.add_edge(cls_id, f"class:{pkg}.{decl['extends']}", EdgeKind.EXTENDS)

            for iface_name in decl.get("implements", []):
                self.graph.add_edge(cls_id, f"iface:{pkg}.{iface_name}", EdgeKind.IMPLEMENTS)

            for ann in annotations:
                ann_id = self.graph.add_node(f"ann:{ann}", NodeKind.ANNOTATION, ann, "java")
                self.graph.add_edge(cls_id, ann_id, EdgeKind.ANNOTATED_WITH)

            for member_kind, member_text in _iter_top_level_members(decl["body"]):
                if member_kind == "stmt":
                    self._process_fallback_field_stmt(member_text, cls_id, pkg, path)
                else:
                    self._process_fallback_block_header(member_text, cls_id, name, fqn, class_http_path, is_controller, pkg, path)

        elif kind == "interface":
            iface_id = f"iface:{fqn}"
            self.graph.add_node(iface_id, NodeKind.INTERFACE, name, "java", file=str(path), fqn=fqn, package=pkg)
            for ext in decl.get("extends", []):
                self.graph.add_edge(iface_id, f"iface:{pkg}.{ext}", EdgeKind.EXTENDS)
            for member_kind, member_text in _iter_top_level_members(decl["body"]):
                if member_kind == "block":
                    self._process_fallback_interface_method(member_text, iface_id, fqn, path)

        elif kind == "enum":
            enum_id = f"class:{fqn}"
            constants = _enum_constants_from_body(decl["body"])
            self.graph.add_node(enum_id, NodeKind.ENUM, name, "java", file=str(path), fqn=fqn, constants=",".join(constants))

    def _process_fallback_field_stmt(self, stmt: str, cls_id: str, pkg: str, path: Path) -> None:
        match = RE_FIELD_STMT.match(stmt.strip())
        if not match:
            return
        ann_block, field_type, field_name = match.groups()
        ann_names = _annotation_names_from_text(ann_block)
        is_injected = any(a in ("Autowired", "Inject", "Value") for a in ann_names)
        f_id = f"field:{cls_id}#{field_name}"
        self.graph.add_node(
            f_id, NodeKind.FIELD, field_name, "java",
            file=str(path), field_type=field_type,
            is_injected=is_injected,
            column_name=_annotation_attr_from_text(ann_block, "Column", "name") or "",
        )
        self.graph.add_edge(cls_id, f_id, EdgeKind.HAS_FIELD)
        if is_injected:
            self.graph.add_edge(cls_id, f"class:{pkg}.{field_type}", EdgeKind.INJECTS)

    def _process_fallback_block_header(self, header: str, cls_id: str, cls_name: str, fqn: str,
                                       class_path: str, is_controller: bool, pkg: str, path: Path) -> None:
        ctor_match = RE_CTOR_HEADER.match(header.strip())
        if ctor_match and ctor_match.group(2) == cls_name:
            ann_block, _, params_text = ctor_match.groups()
            params = _params_str_from_text(params_text)
            ctor_id = f"ctor:{cls_id}({params})"
            self.graph.add_node(ctor_id, NodeKind.CONSTRUCTOR, f"{cls_name}()", "java", file=str(path), params=params)
            self.graph.add_edge(cls_id, ctor_id, EdgeKind.HAS_METHOD)
            for p_type in _param_types_from_text(params_text):
                self.graph.add_edge(cls_id, f"class:{pkg}.{p_type}", EdgeKind.INJECTS)
            return

        method_match = RE_METHOD_HEADER.match(header.strip())
        if not method_match:
            return

        ann_block, return_type, method_name, params_text = method_match.groups()
        ann_names = _annotation_names_from_text(ann_block)
        params = _params_str_from_text(params_text)
        m_id = f"method:{fqn}.{method_name}({params})"

        http_verb = http_path = ""
        for ann, verb in MAPPING_VERBS.items():
            if ann in ann_names:
                http_verb = verb
                raw_path = (
                    _annotation_attr_from_text(ann_block, ann, "value")
                    or _annotation_attr_from_text(ann_block, ann, "path")
                    or ""
                )
                http_path = f"{class_path}/{raw_path}".replace("//", "/")
                break

        self.graph.add_node(
            m_id, NodeKind.METHOD, method_name, "java",
            file=str(path), return_type=return_type, params=params,
            http_verb=http_verb, http_path=http_path,
            is_http_handler=bool(http_verb),
        )
        self.graph.add_edge(cls_id, m_id, EdgeKind.HAS_METHOD)

        if return_type and return_type not in ("void", "String", "int", "long", "boolean", "double", "float"):
            self.graph.add_edge(m_id, f"class:{pkg}.{return_type}", EdgeKind.RETURNS)

    def _process_fallback_interface_method(self, header: str, iface_id: str, fqn: str, path: Path) -> None:
        method_match = RE_METHOD_HEADER.match(header.strip())
        if not method_match:
            return
        _, return_type, method_name, params_text = method_match.groups()
        params = _params_str_from_text(params_text)
        m_id = f"method:{fqn}.{method_name}({params})"
        self.graph.add_node(m_id, NodeKind.METHOD, method_name, "java", file=str(path), return_type=return_type)
        self.graph.add_edge(iface_id, m_id, EdgeKind.HAS_METHOD)
 
 
# ── Utility helpers ───────────────────────────────────────────────────────────
 
def _package_name(tree) -> str:
    return tree.package.name if tree.package else "default"


def _package_name_from_text(source: str) -> str:
    match = RE_PACKAGE.search(source)
    return match.group(1) if match else "default"
 
 
def _annotation_names(node) -> list[str]:
    anns = getattr(node, "annotations", None) or []
    return [a.name for a in anns]
 
 
def _annotation_attr(node, ann_name: str, attr: str) -> Optional[str]:
    for ann in (getattr(node, "annotations", None) or []):
        if ann.name == ann_name and ann.element:
            # element can be a literal, array, or pair list
            elem = ann.element
            if isinstance(elem, javalang.tree.Literal):
                return elem.value.strip('"\'')
            if isinstance(elem, list):
                for pair in elem:
                    if hasattr(pair, "name") and pair.name == attr:
                        v = pair.value
                        if isinstance(v, javalang.tree.Literal):
                            return v.value.strip('"\'')
    return None
 
 
def _type_to_str(t) -> str:
    if t is None:
        return "void"
    name = getattr(t, "name", "") or ""
    args = getattr(t, "arguments", None)
    if args:
        inner = ", ".join(_type_to_str(a.type) for a in args if hasattr(a, "type"))
        return f"{name}<{inner}>"
    return name
 
 
def _params_str(params) -> str:
    if not params:
        return ""
    return ", ".join(_type_to_str(p.type) for p in params)


def _strip_java_comments(source: str) -> str:
    without_block = re.sub(r"/\*.*?\*/", "", source, flags=re.DOTALL)
    return re.sub(r"//.*$", "", without_block, flags=re.MULTILINE)


def _annotation_names_from_text(text: str) -> list[str]:
    return [name.split(".")[-1] for name in re.findall(r"@([\w.]+)", text or "")]


def _annotation_attr_from_text(text: str, ann_name: str, attr: str) -> Optional[str]:
    if not text:
        return None
    ann_match = re.search(rf"@(?:[\w.]*\.)?{re.escape(ann_name)}\((.*?)\)", text, flags=re.DOTALL)
    if not ann_match:
        return None
    inner = ann_match.group(1).strip()
    named_match = re.search(rf"\b{re.escape(attr)}\s*=\s*\"([^\"]+)\"", inner)
    if named_match:
        return named_match.group(1)
    literal_match = re.match(r'\"([^\"]+)\"', inner)
    if literal_match and attr in ("value", "path", "name"):
        return literal_match.group(1)
    return None


def _extract_type_blocks(source: str) -> list[dict]:
    blocks: list[dict] = []
    for match in RE_TYPE_DECL.finditer(source):
        ann_block, kind, name, extends_name, implements_text = match.groups()
        body_start = match.end()
        depth = 1
        idx = body_start
        while idx < len(source) and depth > 0:
            if source[idx] == "{":
                depth += 1
            elif source[idx] == "}":
                depth -= 1
            idx += 1
        body = source[body_start:idx - 1]
        implements = [part.strip() for part in (implements_text or "").split(",") if part.strip()]
        extends_values = [extends_name] if kind == "interface" and extends_name else []
        blocks.append({
            "kind": kind,
            "name": name,
            "annotation_block": ann_block or "",
            "annotations": _annotation_names_from_text(ann_block or ""),
            "extends": extends_name or "",
            "implements": implements,
            "body": body,
        })
        if kind == "interface":
            blocks[-1]["extends"] = extends_values
    return blocks


def _iter_top_level_members(body: str):
    start = 0
    depth = 0
    for idx, char in enumerate(body):
        if char == "{":
            if depth == 0:
                header = body[start:idx].strip()
                if header:
                    yield "block", header
            depth += 1
        elif char == "}":
            depth = max(0, depth - 1)
            if depth == 0:
                start = idx + 1
        elif char == ";" and depth == 0:
            stmt = body[start:idx].strip()
            if stmt:
                yield "stmt", stmt
            start = idx + 1


def _param_types_from_text(params_text: str) -> list[str]:
    types: list[str] = []
    for raw_param in [p.strip() for p in params_text.split(",") if p.strip()]:
        cleaned = re.sub(r"@[\w.]+(?:\([^)]*\))?\s*", "", raw_param)
        tokens = [tok for tok in cleaned.split() if tok not in {"final"}]
        if len(tokens) >= 2:
            types.append(tokens[-2].replace("...", "[]"))
    return types


def _params_str_from_text(params_text: str) -> str:
    return ", ".join(_param_types_from_text(params_text))


def _enum_constants_from_body(body: str) -> list[str]:
    head = body.split(";", 1)[0]
    constants: list[str] = []
    for item in head.split(","):
        name = item.strip().split("(", 1)[0].strip()
        if name and re.match(r"^[A-Z0-9_]+$", name):
            constants.append(name)
    return constants