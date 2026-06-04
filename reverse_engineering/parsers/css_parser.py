"""
CSS / SCSS / LESS Parser
-------------------------
Regex-based parser for .css / .scss / .less files.
Extracts (CSS):
  • Stylesheet node (one per file)
  • Class selectors (.foo, .bar)
  • ID selectors (#foo)
  • Element/tag selectors (div, span, h1, …)
  • CSS custom properties / variables (--my-var: value)
  • @import references (links to other stylesheets)
  • @media query blocks
  • @keyframes animation definitions

SCSS-specific extras:
  • $variable declarations and default values (!default)
  • @mixin definitions with arguments
  • @include call edges (template → mixin)
  • @function definitions with arguments
  • %placeholder selectors
  • @extend relationships (.selector or %placeholder)
  • @use / @forward module system (modern SCSS)
  • @each / @for / @while control-flow blocks
  • // single-line comment stripping
  • Nested rule flattening (extracts inner class/id selectors)
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from core.graph_store import GraphStore, NodeKind, EdgeKind

log = logging.getLogger("css_parser")


# ── Compiled patterns ─────────────────────────────────────────────────────────

# Strip /* ... */ block comments
RE_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
# Strip // line comments (SCSS / LESS)
RE_LINE_COMMENT = re.compile(r"//[^\n]*")

# @import "path" or @import url("path")  [CSS / legacy SCSS]
RE_IMPORT = re.compile(
    r'@import\s+(?:url\s*\(\s*)?["\']([^"\']+)["\']', re.IGNORECASE
)

# SCSS modern module system
RE_USE = re.compile(
    r'@use\s+["\']([^"\']+)["\'](?:\s+as\s+([\w*-]+))?', re.IGNORECASE
)
RE_FORWARD = re.compile(
    r'@forward\s+["\']([^"\']+)["\']', re.IGNORECASE
)

# @media (condition) { ... }
RE_MEDIA = re.compile(
    r'@media\s+([^\{]+)\{', re.IGNORECASE
)

# @keyframes name { ... }
RE_KEYFRAMES = re.compile(
    r'@keyframes\s+([\w-]+)\s*\{', re.IGNORECASE
)

# @mixin name[(args)]  — group 1: name, group 2: optional arg list with parens
RE_MIXIN = re.compile(
    r'@mixin\s+([\w-]+)\s*(\([^)]*\))?', re.IGNORECASE
)

# @include mixin-name
RE_INCLUDE = re.compile(
    r'@include\s+([\w-]+)', re.IGNORECASE
)

# @function name([$args])  — group 1: name, group 2: optional arg list with parens
RE_FUNCTION = re.compile(
    r'@function\s+([\w-]+)\s*(\([^)]*\))?', re.IGNORECASE
)

# %placeholder selector definition
RE_PLACEHOLDER = re.compile(
    r'%([\w-]+)\s*\{'
)

# @extend .selector or @extend %placeholder
RE_EXTEND = re.compile(
    r'@extend\s+([.%][\w-]+)', re.IGNORECASE
)

# @each $var in list
RE_EACH = re.compile(
    r'@each\s+(.+?)\s+in\s+(.+?)\{', re.IGNORECASE
)

# @for $var from start through/to end
RE_FOR = re.compile(
    r'@for\s+(\$[\w-]+)\s+from\s+(\S+)\s+(?:through|to)\s+(\S+)', re.IGNORECASE
)

# @while condition {
RE_WHILE = re.compile(
    r'@while\s+([^{]+)\{', re.IGNORECASE
)

# CSS custom property definition: --my-variable: value;
RE_CSS_VAR_DEF = re.compile(
    r'--([\w-]+)\s*:'
)

# SCSS variable: $name: value [!default];  — group 1: name, group 2: value
RE_SCSS_VAR = re.compile(
    r'\$([\w-]+)\s*:([^;]+);'
)

# Rule block: selectors { ... }  (single-depth, non-greedy)
RE_RULE_BLOCK = re.compile(
    r'([^{@][^{]*?)\{([^{}]*)\}', re.DOTALL
)

# Individual class selectors from a selector string
RE_CLASS_SEL = re.compile(r'\.([\w-]+)')

# Individual ID selectors from a selector string
RE_ID_SEL = re.compile(r'#([\w-]+)')

# HTML element tags (known set to avoid false positives)
HTML_TAGS = frozenset([
    "a", "abbr", "address", "article", "aside", "audio", "b", "blockquote",
    "body", "br", "button", "canvas", "caption", "cite", "code", "col",
    "colgroup", "data", "datalist", "dd", "del", "details", "dfn", "dialog",
    "div", "dl", "dt", "em", "embed", "fieldset", "figcaption", "figure",
    "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header",
    "hr", "html", "i", "iframe", "img", "input", "ins", "kbd", "label",
    "legend", "li", "link", "main", "map", "mark", "menu", "meta", "meter",
    "nav", "noscript", "object", "ol", "optgroup", "option", "output", "p",
    "picture", "pre", "progress", "q", "rp", "rt", "ruby", "s", "samp",
    "script", "section", "select", "small", "source", "span", "strong",
    "style", "sub", "summary", "sup", "table", "tbody", "td", "template",
    "textarea", "tfoot", "th", "thead", "time", "title", "tr", "track",
    "u", "ul", "var", "video", "wbr",
])

_SAFE_PSEUDO = re.compile(r'[:\[\]>+~*()"\']')


class CSSParser:
    """Parse CSS/SCSS/LESS files and populate the knowledge graph."""

    def __init__(self, graph: GraphStore):
        self.graph = graph

    # ------------------------------------------------------------------
    def parse(self, path: Path) -> None:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            log.warning(f"Cannot read {path}: {exc}")
            return

        lang = "scss" if path.suffix.lower() in (".scss", ".sass") else \
               "less" if path.suffix.lower() == ".less" else "css"

        sheet_id = f"stylesheet:{path}"
        sheet_name = path.name
        self.graph.add_node(
            sheet_id,
            kind=NodeKind.STYLESHEET,
            name=sheet_name,
            layer="css",
            file=str(path),
            line=1,
            meta={"lang": lang},
        )

        # Strip comments before further processing
        clean = RE_BLOCK_COMMENT.sub(" ", text)
        if lang in ("scss", "less"):
            clean = RE_LINE_COMMENT.sub(" ", clean)

        self._parse_imports(clean, path, sheet_id)
        self._parse_media(clean, path, sheet_id)
        self._parse_keyframes(clean, path, sheet_id)
        self._parse_css_vars(clean, path, sheet_id)
        if lang in ("scss", "sass"):
            self._parse_scss_vars(clean, path, sheet_id)
            self._parse_mixins(clean, path, sheet_id)
            self._parse_functions(clean, path, sheet_id)
            self._parse_placeholders(clean, path, sheet_id)
            self._parse_extends(clean, path, sheet_id)
            self._parse_use_forward(clean, path, sheet_id)
            self._parse_control_flow(clean, path, sheet_id)
        self._parse_rules(clean, path, sheet_id)

    # ------------------------------------------------------------------
    def _parse_imports(self, text: str, path: Path, sheet_id: str) -> None:
        for m in RE_IMPORT.finditer(text):
            target = m.group(1)
            imp_id = f"css_import:{path}:{target}"
            self.graph.add_node(
                imp_id,
                kind=NodeKind.CSS_IMPORT,
                name=target,
                layer="css",
                file=str(path),
                line=self._line_no(text, m.start()),
                meta={"target": target, "type": "@import"},
            )
            self.graph.add_edge(sheet_id, imp_id, kind=EdgeKind.IMPORTS)

    # ------------------------------------------------------------------
    def _parse_media(self, text: str, path: Path, sheet_id: str) -> None:
        for m in RE_MEDIA.finditer(text):
            condition = m.group(1).strip()
            med_id = f"css_media:{path}:{condition[:60]}"
            self.graph.add_node(
                med_id,
                kind=NodeKind.CSS_MEDIA,
                name=f"@media {condition[:40]}",
                layer="css",
                file=str(path),
                line=self._line_no(text, m.start()),
                meta={"condition": condition},
            )
            self.graph.add_edge(sheet_id, med_id, kind=EdgeKind.HAS_RULE)

    # ------------------------------------------------------------------
    def _parse_keyframes(self, text: str, path: Path, sheet_id: str) -> None:
        for m in RE_KEYFRAMES.finditer(text):
            name = m.group(1)
            kf_id = f"css_keyframe:{path}:{name}"
            self.graph.add_node(
                kf_id,
                kind=NodeKind.CSS_KEYFRAME,
                name=f"@keyframes {name}",
                layer="css",
                file=str(path),
                line=self._line_no(text, m.start()),
                meta={},
            )
            self.graph.add_edge(sheet_id, kf_id, kind=EdgeKind.HAS_RULE)

    # ------------------------------------------------------------------
    def _parse_css_vars(self, text: str, path: Path, sheet_id: str) -> None:
        seen: set = set()
        for m in RE_CSS_VAR_DEF.finditer(text):
            var_name = m.group(1)
            if var_name in seen:
                continue
            seen.add(var_name)
            var_id = f"css_var:{path}:{var_name}"
            self.graph.add_node(
                var_id,
                kind=NodeKind.CSS_VARIABLE,
                name=f"--{var_name}",
                layer="css",
                file=str(path),
                line=self._line_no(text, m.start()),
                meta={},
            )
            self.graph.add_edge(sheet_id, var_id, kind=EdgeKind.DEFINES)

    # ------------------------------------------------------------------
    def _parse_scss_vars(self, text: str, path: Path, sheet_id: str) -> None:
        seen: set = set()
        for m in RE_SCSS_VAR.finditer(text):
            var_name = m.group(1)
            raw_value = m.group(2).strip()
            is_default = "!default" in raw_value
            value = raw_value.replace("!default", "").strip()
            if var_name in seen:
                continue
            seen.add(var_name)
            var_id = f"scss_var:{path}:{var_name}"
            self.graph.add_node(
                var_id,
                kind=NodeKind.CSS_VARIABLE,
                name=f"${var_name}",
                layer="css",
                file=str(path),
                line=self._line_no(text, m.start()),
                meta={"scss": True, "default": is_default, "value": value[:80]},
            )
            self.graph.add_edge(sheet_id, var_id, kind=EdgeKind.DEFINES)

    # ------------------------------------------------------------------
    def _parse_mixins(self, text: str, path: Path, sheet_id: str) -> None:
        for m in RE_MIXIN.finditer(text):
            name = m.group(1)
            args_raw = (m.group(2) or "").strip("()")
            args = [a.strip() for a in args_raw.split(",") if a.strip()] if args_raw else []
            mixin_id = f"scss_mixin:{path}:{name}"
            self.graph.add_node(
                mixin_id,
                kind=NodeKind.CSS_MIXIN,
                name=f"@mixin {name}",
                layer="css",
                file=str(path),
                line=self._line_no(text, m.start()),
                meta={"args": args},
            )
            self.graph.add_edge(sheet_id, mixin_id, kind=EdgeKind.DEFINES)
            # Link @include calls to this mixin within the same file
            for inc_m in RE_INCLUDE.finditer(text):
                if inc_m.group(1) == name:
                    self.graph.add_edge(sheet_id, mixin_id, kind=EdgeKind.CALLS)

    # ------------------------------------------------------------------
    def _parse_functions(self, text: str, path: Path, sheet_id: str) -> None:
        for m in RE_FUNCTION.finditer(text):
            name = m.group(1)
            args_raw = (m.group(2) or "").strip("()")
            args = [a.strip() for a in args_raw.split(",") if a.strip()] if args_raw else []
            fn_id = f"scss_function:{path}:{name}"
            self.graph.add_node(
                fn_id,
                kind=NodeKind.CSS_MIXIN,  # reuse MIXIN kind; differentiated by meta
                name=f"@function {name}",
                layer="css",
                file=str(path),
                line=self._line_no(text, m.start()),
                meta={"is_function": True, "args": args},
            )
            self.graph.add_edge(sheet_id, fn_id, kind=EdgeKind.DEFINES)

    # ------------------------------------------------------------------
    def _parse_placeholders(self, text: str, path: Path, sheet_id: str) -> None:
        """Extract %placeholder selectors (SCSS silent classes)."""
        for m in RE_PLACEHOLDER.finditer(text):
            name = m.group(1).strip()
            ph_id = f"scss_placeholder:{path}:{name}"
            self.graph.add_node(
                ph_id,
                kind=NodeKind.CSS_CLASS,
                name=f"%{name}",
                layer="css",
                file=str(path),
                line=self._line_no(text, m.start()),
                meta={"placeholder": True},
            )
            self.graph.add_edge(sheet_id, ph_id, kind=EdgeKind.DEFINES)

    # ------------------------------------------------------------------
    def _parse_extends(self, text: str, path: Path, sheet_id: str) -> None:
        """Capture @extend relationships and link to the target selector node."""
        for m in RE_EXTEND.finditer(text):
            target = m.group(1)  # e.g. ".btn" or "%clearfix"
            is_placeholder = target.startswith("%")
            name = target.lstrip(".%")
            prefix = "scss_placeholder" if is_placeholder else "css_class"
            target_id = f"{prefix}:{path}:{name}"
            ext_id = f"scss_extend:{path}:{target}:{m.start()}"
            self.graph.add_node(
                ext_id,
                kind=NodeKind.CSS_CLASS,
                name=f"@extend {target}",
                layer="css",
                file=str(path),
                line=self._line_no(text, m.start()),
                meta={"extend_target": target},
            )
            self.graph.add_edge(sheet_id, ext_id, kind=EdgeKind.HAS_RULE)
            # If the target node exists in the graph, add an EXTENDS edge
            if self.graph.has_node(target_id):
                self.graph.add_edge(ext_id, target_id, kind=EdgeKind.EXTENDS)

    # ------------------------------------------------------------------
    def _parse_use_forward(self, text: str, path: Path, sheet_id: str) -> None:
        """Handle SCSS @use and @forward (modern module system)."""
        for m in RE_USE.finditer(text):
            module = m.group(1)
            alias = m.group(2) or ""
            imp_id = f"scss_use:{path}:{module}"
            self.graph.add_node(
                imp_id,
                kind=NodeKind.CSS_IMPORT,
                name=f"@use '{module}'",
                layer="css",
                file=str(path),
                line=self._line_no(text, m.start()),
                meta={"target": module, "type": "@use", "alias": alias},
            )
            self.graph.add_edge(sheet_id, imp_id, kind=EdgeKind.IMPORTS)

        for m in RE_FORWARD.finditer(text):
            module = m.group(1)
            fwd_id = f"scss_forward:{path}:{module}"
            self.graph.add_node(
                fwd_id,
                kind=NodeKind.CSS_IMPORT,
                name=f"@forward '{module}'",
                layer="css",
                file=str(path),
                line=self._line_no(text, m.start()),
                meta={"target": module, "type": "@forward"},
            )
            self.graph.add_edge(sheet_id, fwd_id, kind=EdgeKind.IMPORTS)

    # ------------------------------------------------------------------
    def _parse_control_flow(self, text: str, path: Path, sheet_id: str) -> None:
        """Capture SCSS @each / @for / @while control-flow blocks."""
        for m in RE_EACH.finditer(text):
            vars_part = m.group(1).strip()
            list_part = m.group(2).strip()[:60]
            cf_id = f"scss_each:{path}:{m.start()}"
            self.graph.add_node(
                cf_id,
                kind=NodeKind.CSS_MEDIA,  # reuse as a 'block' kind
                name=f"@each {vars_part}",
                layer="css",
                file=str(path),
                line=self._line_no(text, m.start()),
                meta={"control": "each", "vars": vars_part, "list": list_part},
            )
            self.graph.add_edge(sheet_id, cf_id, kind=EdgeKind.HAS_RULE)

        for m in RE_FOR.finditer(text):
            var = m.group(1)
            cf_id = f"scss_for:{path}:{m.start()}"
            self.graph.add_node(
                cf_id,
                kind=NodeKind.CSS_MEDIA,
                name=f"@for {var}",
                layer="css",
                file=str(path),
                line=self._line_no(text, m.start()),
                meta={"control": "for", "var": var,
                      "from": m.group(2), "to": m.group(3)},
            )
            self.graph.add_edge(sheet_id, cf_id, kind=EdgeKind.HAS_RULE)

        for m in RE_WHILE.finditer(text):
            condition = m.group(1).strip()[:60]
            cf_id = f"scss_while:{path}:{m.start()}"
            self.graph.add_node(
                cf_id,
                kind=NodeKind.CSS_MEDIA,
                name=f"@while {condition}",
                layer="css",
                file=str(path),
                line=self._line_no(text, m.start()),
                meta={"control": "while", "condition": condition},
            )
            self.graph.add_edge(sheet_id, cf_id, kind=EdgeKind.HAS_RULE)

    # ------------------------------------------------------------------
    def _parse_rules(self, text: str, path: Path, sheet_id: str) -> None:
        seen_classes: set = set()
        seen_ids: set = set()

        for m in RE_RULE_BLOCK.finditer(text):
            raw_selector = m.group(1).strip()

            # Skip @-rules captured by the pattern
            if raw_selector.startswith("@") or not raw_selector:
                continue

            selector = raw_selector.replace("\n", " ").strip()

            # Class selectors
            for cls_m in RE_CLASS_SEL.finditer(selector):
                cls_name = cls_m.group(1)
                if cls_name in seen_classes:
                    continue
                seen_classes.add(cls_name)
                cls_id = f"css_class:{path}:{cls_name}"
                self.graph.add_node(
                    cls_id,
                    kind=NodeKind.CSS_CLASS,
                    name=f".{cls_name}",
                    layer="css",
                    file=str(path),
                    line=self._line_no(text, m.start()),
                    meta={"selector": selector},
                )
                self.graph.add_edge(sheet_id, cls_id, kind=EdgeKind.HAS_RULE)

            # ID selectors
            for id_m in RE_ID_SEL.finditer(selector):
                id_name = id_m.group(1)
                if id_name in seen_ids:
                    continue
                seen_ids.add(id_name)
                css_id = f"css_id:{path}:{id_name}"
                self.graph.add_node(
                    css_id,
                    kind=NodeKind.CSS_ID_SELECTOR,
                    name=f"#{id_name}",
                    layer="css",
                    file=str(path),
                    line=self._line_no(text, m.start()),
                    meta={"selector": selector},
                )
                self.graph.add_edge(sheet_id, css_id, kind=EdgeKind.HAS_RULE)

            # Element/tag selectors (only single-word clean tokens)
            for token in _SAFE_PSEUDO.sub(" ", selector).split():
                token = token.strip(".,>+~*")
                if token and token.lower() in HTML_TAGS:
                    tag_id = f"css_tag:{path}:{token.lower()}"
                    if not self.graph.has_node(tag_id):
                        self.graph.add_node(
                            tag_id,
                            kind=NodeKind.CSS_ELEMENT,
                            name=token.lower(),
                            layer="css",
                            file=str(path),
                            line=self._line_no(text, m.start()),
                            meta={},
                        )
                    self.graph.add_edge(sheet_id, tag_id, kind=EdgeKind.HAS_RULE)

    # ------------------------------------------------------------------
    @staticmethod
    def _line_no(text: str, pos: int) -> int:
        return text[:pos].count("\n") + 1
