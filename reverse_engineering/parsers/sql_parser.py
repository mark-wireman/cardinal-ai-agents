"""

PostgreSQL / SQL Parser

------------------------

Uses `sqlparse` + regex fallback to extract:

  • CREATE TABLE — columns, primary keys, data types, NOT NULL, DEFAULT

  • CREATE INDEX / UNIQUE INDEX

  • CREATE VIEW

  • CREATE SEQUENCE

  • ALTER TABLE ADD CONSTRAINT FOREIGN KEY → FK edges between Table nodes

  • Column → Table BELONGS_TO edges

  • FK → referenced Table REFERENCES edges

"""
 
from __future__ import annotations
 
import logging

import re

from pathlib import Path
 
from core.graph_store import GraphStore, NodeKind, EdgeKind
 
log = logging.getLogger("sql_parser")
 
try:

    import sqlparse

    SQLPARSE_OK = True

except ImportError:

    SQLPARSE_OK = False

    log.warning("sqlparse not installed — SQL parsing will use regex fallback. "

                "Run: pip install sqlparse")
 
 
# ── Compiled patterns ─────────────────────────────────────────────────────────
 
RE_CREATE_TABLE  = re.compile(

    r"CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"

    r"(?:\"?(\w+)\"?\.)?"          # optional schema

    r"\"?(\w+)\"?\s*\(",

    re.IGNORECASE,

)

RE_COLUMN_LINE   = re.compile(

    r"^\s*\"?(\w+)\"?\s+"

    r"((?:character\s+varying|timestamp\s+(?:with|without)\s+time\s+zone"

    r"|double\s+precision|[\w]+)(?:\s*\(\s*[\d,\s]+\s*\))?)"

    r"(.*?)$",

    re.IGNORECASE,

)

RE_PK_INLINE     = re.compile(r"\bPRIMARY\s+KEY\b", re.IGNORECASE)

RE_NOT_NULL      = re.compile(r"\bNOT\s+NULL\b",    re.IGNORECASE)

RE_UNIQUE        = re.compile(r"\bUNIQUE\b",         re.IGNORECASE)

RE_DEFAULT       = re.compile(r"\bDEFAULT\s+(\S+)", re.IGNORECASE)

RE_TABLE_PK      = re.compile(

    r"CONSTRAINT\s+\w+\s+PRIMARY\s+KEY\s*\(([^)]+)\)", re.IGNORECASE

)

RE_FK_INLINE     = re.compile(

    r"REFERENCES\s+\"?(\w+)\"?\s*\(([^)]+)\)", re.IGNORECASE

)

RE_ALTER_FK      = re.compile(

    r"ALTER\s+TABLE\s+(?:ONLY\s+)?(?:\"?\w+\"?\.)?"

    r"\"?(\w+)\"?\s+ADD\s+CONSTRAINT\s+\w+\s+FOREIGN\s+KEY\s*\(([^)]+)\)\s*"

    r"REFERENCES\s+(?:\"?\w+\"?\.)?"

    r"\"?(\w+)\"?\s*\(([^)]+)\)",

    re.IGNORECASE,

)

RE_CREATE_INDEX  = re.compile(

    r"CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"

    r"(\w+)\s+ON\s+(?:\"?\w+\"?\.)?"

    r"\"?(\w+)\"?\s*(?:USING\s+\w+\s*)?\(([^)]+)\)",

    re.IGNORECASE,

)

RE_CREATE_VIEW   = re.compile(

    r"CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:\"?\w+\"?\.)?"

    r"\"?(\w+)\"?\s+AS",

    re.IGNORECASE,

)

RE_CREATE_SEQ    = re.compile(

    r"CREATE\s+SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\"?\w+\"?\.)?"

    r"\"?(\w+)\"?",

    re.IGNORECASE,

)
 
 
class SQLParser:

    def __init__(self, graph: GraphStore) -> None:

        self.graph = graph
 
    # ── Public ────────────────────────────────────────────────────────────────
 
    def parse(self, path: Path) -> None:

        src = path.read_text(encoding="utf-8", errors="replace")

        rel = str(path)
 
        statements = (

            [str(s) for s in sqlparse.parse(src) if str(s).strip()]

            if SQLPARSE_OK

            else _split_statements(src)

        )
 
        for stmt in statements:

            stmt_clean = stmt.strip()

            if not stmt_clean:

                continue

            u = stmt_clean.upper().lstrip()

            if u.startswith("CREATE") and "TABLE" in u:

                self._parse_create_table(stmt_clean, rel)

            elif u.startswith("ALTER") and "FOREIGN KEY" in u:

                self._parse_alter_fk(stmt_clean, rel)

            elif u.startswith("CREATE") and "INDEX" in u:

                self._parse_create_index(stmt_clean, rel)

            elif u.startswith("CREATE") and "VIEW" in u:

                self._parse_create_view(stmt_clean, rel)

            elif u.startswith("CREATE") and "SEQUENCE" in u:

                self._parse_create_sequence(stmt_clean, rel)
 
    # ── CREATE TABLE ──────────────────────────────────────────────────────────
 
    def _parse_create_table(self, stmt: str, rel: str) -> None:

        m = RE_CREATE_TABLE.search(stmt)

        if not m:

            return

        schema, table_name = m.group(1) or "public", m.group(2)

        table_id = f"table:{schema}.{table_name}"
 
        self.graph.add_node(

            table_id, NodeKind.TABLE, table_name, "sql",

            file=rel, schema=schema, fqn=f"{schema}.{table_name}"

        )
 
        # Extract body between outer parentheses

        body_start = stmt.index("(", m.start()) + 1

        body       = _extract_paren_body(stmt, body_start - 1)

        if not body:

            return
 
        pk_columns: set[str] = set()

        # Table-level PK constraint

        for pk_m in RE_TABLE_PK.finditer(body):

            pk_columns.update(c.strip().strip('"') for c in pk_m.group(1).split(","))
 
        for line in _split_column_lines(body):

            line = line.strip()

            if not line:

                continue

            upper = line.upper()

            # Skip constraint lines

            if upper.startswith(("CONSTRAINT", "PRIMARY KEY", "UNIQUE (", "CHECK (")):

                continue
 
            col_m = RE_COLUMN_LINE.match(line)

            if not col_m:

                continue
 
            col_name  = col_m.group(1)

            col_type  = col_m.group(2).strip()

            remainder = col_m.group(3)
 
            is_pk      = bool(RE_PK_INLINE.search(remainder)) or col_name in pk_columns

            not_null   = bool(RE_NOT_NULL.search(remainder))

            is_unique  = bool(RE_UNIQUE.search(remainder))

            def_val_m  = RE_DEFAULT.search(remainder)

            default    = def_val_m.group(1) if def_val_m else ""
 
            col_id = f"col:{table_id}#{col_name}"

            self.graph.add_node(

                col_id, NodeKind.COLUMN, col_name, "sql",

                file=rel, col_type=col_type,

                is_pk=is_pk, not_null=not_null,

                is_unique=is_unique, default=default,

                table=table_name,

            )

            self.graph.add_edge(table_id, col_id, EdgeKind.HAS_COLUMN)

            self.graph.add_edge(col_id, table_id, EdgeKind.BELONGS_TO)
 
            # Inline FK

            fk_m = RE_FK_INLINE.search(remainder)

            if fk_m:

                ref_table = fk_m.group(1)

                ref_col   = fk_m.group(2).strip()

                fk_id     = f"fk:{table_id}#{col_name}->{ref_table}"

                self.graph.add_node(

                    fk_id, NodeKind.FOREIGN_KEY,

                    f"{col_name} → {ref_table}.{ref_col}", "sql",

                    file=rel, from_col=col_name, to_table=ref_table, to_col=ref_col,

                )

                self.graph.add_edge(col_id, f"table:public.{ref_table}", EdgeKind.REFERENCES)

                self.graph.add_edge(table_id, fk_id, EdgeKind.HAS_COLUMN)
 
    # ── ALTER TABLE … FOREIGN KEY ─────────────────────────────────────────────
 
    def _parse_alter_fk(self, stmt: str, rel: str) -> None:

        for m in RE_ALTER_FK.finditer(stmt):

            from_table = m.group(1)

            from_cols  = [c.strip() for c in m.group(2).split(",")]

            to_table   = m.group(3)

            to_cols    = [c.strip() for c in m.group(4).split(",")]
 
            fk_id = self.graph.add_node(

                f"fk:{from_table}({','.join(from_cols)})->{to_table}({','.join(to_cols)})",

                NodeKind.FOREIGN_KEY,

                f"{from_table} → {to_table}",

                "sql",

                file=rel,

                from_table=from_table, from_cols=",".join(from_cols),

                to_table=to_table,     to_cols=",".join(to_cols),

            )

            self.graph.add_edge(

                f"table:public.{from_table}",

                f"table:public.{to_table}",

                EdgeKind.REFERENCES,

            )
 
    # ── CREATE INDEX ──────────────────────────────────────────────────────────
 
    def _parse_create_index(self, stmt: str, rel: str) -> None:

        m = RE_CREATE_INDEX.search(stmt)

        if not m:

            return

        idx_name, table_name, cols_str = m.group(1), m.group(2), m.group(3)

        idx_id = f"idx:{idx_name}"

        self.graph.add_node(

            idx_id, NodeKind.INDEX, idx_name, "sql",

            file=rel, table=table_name,

            columns=cols_str.strip(),

            is_unique="UNIQUE" in stmt.upper(),

        )

        self.graph.add_edge(f"table:public.{table_name}", idx_id, EdgeKind.HAS_INDEX)
 
    # ── CREATE VIEW ───────────────────────────────────────────────────────────
 
    def _parse_create_view(self, stmt: str, rel: str) -> None:

        m = RE_CREATE_VIEW.search(stmt)

        if not m:

            return

        view_name = m.group(1)

        self.graph.add_node(

            f"view:{view_name}", NodeKind.VIEW, view_name, "sql", file=rel

        )
 
    # ── CREATE SEQUENCE ───────────────────────────────────────────────────────
 
    def _parse_create_sequence(self, stmt: str, rel: str) -> None:

        m = RE_CREATE_SEQ.search(stmt)

        if not m:

            return

        seq_name = m.group(1)

        self.graph.add_node(

            f"seq:{seq_name}", NodeKind.SEQUENCE, seq_name, "sql", file=rel

        )
 
 
# ── Helpers ───────────────────────────────────────────────────────────────────
 
def _split_statements(src: str) -> list[str]:

    """Naive semicolon split as fallback when sqlparse unavailable."""

    return [s.strip() for s in src.split(";") if s.strip()]
 
 
def _extract_paren_body(src: str, start: int) -> str | None:

    depth = 0

    i     = start

    begin = None

    while i < len(src):

        c = src[i]

        if c == "(":

            if begin is None:

                begin = i

            depth += 1

        elif c == ")":

            depth -= 1

            if depth == 0 and begin is not None:

                return src[begin + 1:i]

        i += 1

    return None
 
 
def _split_column_lines(body: str) -> list[str]:

    """Split on commas while respecting nested parentheses."""

    lines, current, depth = [], [], 0

    for ch in body:

        if ch == "(":

            depth += 1

            current.append(ch)

        elif ch == ")":

            depth -= 1

            current.append(ch)

        elif ch == "," and depth == 0:

            lines.append("".join(current))

            current = []

        else:

            current.append(ch)

    if current:

        lines.append("".join(current))

    return lines
 