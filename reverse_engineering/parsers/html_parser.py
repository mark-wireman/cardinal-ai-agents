"""
HTML / Angular Template Parser
---------------------------------
Uses Python's built-in html.parser.HTMLParser to parse .html / .htm files.
Extracts:
  • HTML document node (one per file)
  • Angular component selectors used as custom elements (<app-header>, etc.)
  • All standard HTML elements (div, form, button, a, img, input, …)
  • IDs and class attributes — creates reference edges to CSS nodes
  • <a href="…"> links
  • <link href="…" rel="stylesheet"> stylesheets loaded
  • <script src="…"> script imports
  • <form action="…"> form endpoints
  • Angular template directives: *ngIf, *ngFor, routerLink, [routerLink],
    [(ngModel)], (click), [src], [href], [style.*], [class.*]
  • Angular interpolation {{ expression }} references
  • data-* attributes
"""

from __future__ import annotations

import logging
import re
from html.parser import HTMLParser
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from core.graph_store import GraphStore, NodeKind, EdgeKind

log = logging.getLogger("html_parser")


# Angular component selector pattern: words separated by dashes, starting with
# a letter, containing at least one dash (e.g. app-header, mat-button).
RE_ANGULAR_COMPONENT = re.compile(r'^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$')

# Angular expression references inside {{ ... }}
RE_INTERPOLATION = re.compile(r'\{\{\s*([\w.]+)\s*\}\}')

# Angular attribute patterns
RE_NG_DIRECTIVE = re.compile(
    r'^\*?(?:ng(?:If|For|Switch|Class|Style|Model|Template|Container)|'
    r'routerLink(?:Active)?|let-\w+|trackBy)$',
    re.IGNORECASE
)

# CSS class split
RE_WS = re.compile(r'\s+')

HTML_TAGS = frozenset([
    "a", "abbr", "address", "article", "aside", "audio", "b", "blockquote",
    "body", "button", "canvas", "caption", "code", "col", "colgroup",
    "datalist", "dd", "details", "dialog", "div", "dl", "dt", "em",
    "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
    "h4", "h5", "h6", "head", "header", "hr", "html", "i", "iframe", "img",
    "input", "label", "legend", "li", "link", "main", "meta", "nav", "ol",
    "option", "output", "p", "pre", "progress", "script", "section", "select",
    "small", "span", "strong", "style", "summary", "table", "tbody", "td",
    "template", "textarea", "tfoot", "th", "thead", "title", "tr", "ul",
    "video",
])


class _HTMLVisitor(HTMLParser):
    """Internal HTMLParser subclass that collects structural data."""

    def __init__(self, graph: GraphStore, path: Path, doc_id: str) -> None:
        super().__init__(convert_charrefs=False)
        self.graph = graph
        self.path = path
        self.doc_id = doc_id
        self._seen_classes: set = set()
        self._seen_ids: set = set()
        self._seen_components: set = set()
        self._tag_counts: Dict[str, int] = {}

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        attr_dict = {k.lower(): (v or "") for k, v in attrs}

        # Angular component (custom element with dashes)
        if RE_ANGULAR_COMPONENT.match(tag):
            self._record_component(tag, attr_dict)
        elif tag.lower() in HTML_TAGS:
            self._record_html_element(tag.lower(), attr_dict)

        # Process shared attribute concerns regardless of tag type
        self._process_id_attr(attr_dict)
        self._process_class_attr(attr_dict)
        self._process_angular_directives(tag, attr_dict)

    def handle_data(self, data: str) -> None:
        for m in RE_INTERPOLATION.finditer(data):
            expr = m.group(1)
            expr_id = f"html_binding:{self.path}:{expr}"
            if not self.graph.has_node(expr_id):
                self.graph.add_node(
                    expr_id,
                    kind=NodeKind.HTML_BINDING,
                    name=f"{{{{ {expr} }}}}",
                    layer="html",
                    file=str(self.path),
                    line=-1,
                    meta={"expression": expr},
                )
                self.graph.add_edge(self.doc_id, expr_id, kind=EdgeKind.BINDS)

    # ------------------------------------------------------------------
    def _record_component(self, tag: str, attrs: Dict[str, str]) -> None:
        if tag in self._seen_components:
            return
        self._seen_components.add(tag)
        comp_id = f"html_component:{self.path}:{tag}"
        self.graph.add_node(
            comp_id,
            kind=NodeKind.HTML_COMPONENT,
            name=f"<{tag}>",
            layer="html",
            file=str(self.path),
            line=-1,
            meta={"selector": tag, "attrs": list(attrs.keys())},
        )
        self.graph.add_edge(self.doc_id, comp_id, kind=EdgeKind.USES_COMPONENT)

    def _record_html_element(self, tag: str, attrs: Dict[str, str]) -> None:
        # Special handling for link/script/form/a (rich semantic)
        if tag == "link" and attrs.get("rel", "").lower() == "stylesheet":
            href = attrs.get("href", "")
            if href:
                link_id = f"html_stylesheet_link:{self.path}:{href}"
                self.graph.add_node(
                    link_id,
                    kind=NodeKind.HTML_ELEMENT,
                    name=f"<link> {href}",
                    layer="html",
                    file=str(self.path),
                    line=-1,
                    meta={"tag": "link", "href": href},
                )
                self.graph.add_edge(self.doc_id, link_id, kind=EdgeKind.LINKS_TO)
            return

        if tag == "script":
            src = attrs.get("src", "")
            if src:
                sc_id = f"html_script:{self.path}:{src}"
                self.graph.add_node(
                    sc_id,
                    kind=NodeKind.HTML_SCRIPT,
                    name=f"<script> {src}",
                    layer="html",
                    file=str(self.path),
                    line=-1,
                    meta={"src": src},
                )
                self.graph.add_edge(self.doc_id, sc_id, kind=EdgeKind.INCLUDES)
            return

        if tag == "a":
            href = attrs.get("href", "")
            if href and not href.startswith("#") and not href.startswith("javascript:"):
                a_id = f"html_link:{self.path}:{href}"
                self.graph.add_node(
                    a_id,
                    kind=NodeKind.HTML_LINK,
                    name=f"<a> {href[:50]}",
                    layer="html",
                    file=str(self.path),
                    line=-1,
                    meta={"href": href},
                )
                self.graph.add_edge(self.doc_id, a_id, kind=EdgeKind.LINKS_TO)
            return

        if tag == "form":
            action = attrs.get("action", "")
            method = attrs.get("method", "GET").upper()
            form_id = f"html_form:{self.path}:{action or 'inline'}"
            self.graph.add_node(
                form_id,
                kind=NodeKind.HTML_FORM,
                name=f"<form> {action or '(inline)'}",
                layer="html",
                file=str(self.path),
                line=-1,
                meta={"action": action, "method": method},
            )
            self.graph.add_edge(self.doc_id, form_id, kind=EdgeKind.HAS_ELEMENT)
            return

        # Generic element — count occurrences to avoid building massive graphs
        count = self._tag_counts.get(tag, 0)
        self._tag_counts[tag] = count + 1
        if count == 0:  # only add a node for first occurrence per file
            elem_id = f"html_elem:{self.path}:{tag}"
            if not self.graph.has_node(elem_id):
                self.graph.add_node(
                    elem_id,
                    kind=NodeKind.HTML_ELEMENT,
                    name=f"<{tag}>",
                    layer="html",
                    file=str(self.path),
                    line=-1,
                    meta={"tag": tag},
                )
                self.graph.add_edge(self.doc_id, elem_id, kind=EdgeKind.HAS_ELEMENT)

    # ------------------------------------------------------------------
    def _process_id_attr(self, attrs: Dict[str, str]) -> None:
        elem_id = attrs.get("id", "").strip()
        if not elem_id or elem_id in self._seen_ids:
            return
        self._seen_ids.add(elem_id)
        node_id = f"html_id:{self.path}:{elem_id}"
        self.graph.add_node(
            node_id,
            kind=NodeKind.HTML_ID,
            name=f"#{elem_id}",
            layer="html",
            file=str(self.path),
            line=-1,
            meta={"id": elem_id},
        )
        self.graph.add_edge(self.doc_id, node_id, kind=EdgeKind.HAS_ELEMENT)

    def _process_class_attr(self, attrs: Dict[str, str]) -> None:
        class_str = attrs.get("class", "").strip()
        if not class_str:
            return
        for cls in RE_WS.split(class_str):
            cls = cls.strip()
            if not cls or cls in self._seen_classes:
                continue
            self._seen_classes.add(cls)
            cls_node_id = f"html_class_ref:{self.path}:{cls}"
            self.graph.add_node(
                cls_node_id,
                kind=NodeKind.HTML_CLASS_REF,
                name=f".{cls}",
                layer="html",
                file=str(self.path),
                line=-1,
                meta={"class": cls},
            )
            self.graph.add_edge(self.doc_id, cls_node_id, kind=EdgeKind.USES_CLASS)

    def _process_angular_directives(self, tag: str, attrs: Dict[str, str]) -> None:
        for attr_key, attr_val in attrs.items():
            key = attr_key.strip()

            # *ngIf, *ngFor, [routerLink], etc.
            if RE_NG_DIRECTIVE.match(key.lstrip("*[()")):
                directive_name = key.lstrip("*[()]").rstrip("])")
                dir_id = f"html_directive:{self.path}:{directive_name}:{attr_val[:40]}"
                self.graph.add_node(
                    dir_id,
                    kind=NodeKind.HTML_DIRECTIVE,
                    name=directive_name,
                    layer="html",
                    file=str(self.path),
                    line=-1,
                    meta={"directive": directive_name, "value": attr_val[:120], "tag": tag},
                )
                self.graph.add_edge(self.doc_id, dir_id, kind=EdgeKind.USES_DIRECTIVE)

            # (click)="handler()" → event binding
            elif key.startswith("(") and key.endswith(")"):
                event = key[1:-1]
                ev_id = f"html_event:{self.path}:{tag}:{event}"
                self.graph.add_node(
                    ev_id,
                    kind=NodeKind.HTML_BINDING,
                    name=f"({event})",
                    layer="html",
                    file=str(self.path),
                    line=-1,
                    meta={"event": event, "handler": attr_val[:120], "tag": tag},
                )
                self.graph.add_edge(self.doc_id, ev_id, kind=EdgeKind.BINDS)


# ── Public parser class ──────────────────────────────────────────────────────


class HTMLParser_:
    """Parse HTML / Angular template files and populate the knowledge graph."""

    def __init__(self, graph: GraphStore):
        self.graph = graph

    def parse(self, path: Path) -> None:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            log.warning(f"Cannot read {path}: {exc}")
            return

        doc_id = f"html_doc:{path}"
        self.graph.add_node(
            doc_id,
            kind=NodeKind.HTML_DOCUMENT,
            name=path.name,
            layer="html",
            file=str(path),
            line=1,
            meta={"size_bytes": len(text.encode())},
        )

        visitor = _HTMLVisitor(self.graph, path, doc_id)
        try:
            visitor.feed(text)
        except Exception as exc:
            log.warning(f"  HTML parse error in {path.name}: {exc}")
