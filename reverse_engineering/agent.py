"""
Full-Stack Reverse Engineering Agent
=====================================
Supports: Spring Boot (Java), Angular (TypeScript), Node.js (JavaScript), PostgreSQL (SQL)
Output  : A local knowledge graph (JSON + GraphML) representing all structural relationships.
 
Usage:
    python agent.py --root /path/to/project [--output ./kg_output] [--format all]
 
Dependencies (pip install):
    javalang networkx sqlparse colorama tqdm
"""
 
import argparse
import logging
import sys
from pathlib import Path
 
from colorama import Fore, Style, init as colorama_init
 
from core.scanner      import FileScanner
from core.graph_store  import GraphStore
from parsers.java_parser  import JavaParser
from parsers.ts_parser    import TypeScriptParser
from parsers.js_parser    import JavaScriptParser
from parsers.sql_parser   import SQLParser
from parsers.css_parser   import CSSParser
from parsers.html_parser  import HTMLParser_ as HTMLParser
from reporters.summary    import SummaryReporter
 
colorama_init(autoreset=True)
logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")
log = logging.getLogger("agent")
 
BANNER = f"""
{Fore.CYAN}╔══════════════════════════════════════════════════════════╗
║   Full-Stack Reverse Engineering Agent  v1.1             ║
║   Spring Boot · Angular · Node.js · PostgreSQL           ║
║   CSS / SCSS / LESS · HTML / Angular Templates          ║
╚══════════════════════════════════════════════════════════╝{Style.RESET_ALL}
"""
 
 
def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Reverse-engineer a full-stack project into a knowledge graph.")
    p.add_argument("--root",   required=True,        help="Root directory of the project to analyse")
    p.add_argument("--output", default="./kg_output", help="Directory to store graph artefacts (default: ./kg_output)")
    p.add_argument("--format", default="all",
                   choices=["json", "graphml", "all"],
                   help="Output format for the knowledge graph")
    p.add_argument("--verbose", action="store_true",  help="Enable verbose/debug logging")
    p.add_argument("--skip",   nargs="*", default=[],
                   metavar="DIR",
                   help="Directory names to exclude (e.g. node_modules .git target)")
    return p
 
 
def run(args: argparse.Namespace) -> None:
    print(BANNER)
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)
 
    root   = Path(args.root).resolve()
    output = Path(args.output).resolve()
 
    if not root.exists():
        log.error(f"Project root not found: {root}")
        sys.exit(1)
 
    output.mkdir(parents=True, exist_ok=True)
    log.info(f"Project root : {root}")
    log.info(f"Output dir   : {output}")
 
    # ── 1. Discover files ─────────────────────────────────────────────────────
    skip_dirs = set(args.skip) | {"node_modules", ".git", "target", "build", "__pycache__", ".angular", "dist"}
    scanner   = FileScanner(root, skip_dirs=skip_dirs)
    file_map  = scanner.scan()
    log.info(f"Discovered files → Java:{len(file_map['java'])}  "
             f"TS:{len(file_map['ts'])}  JS:{len(file_map['js'])}  SQL:{len(file_map['sql'])}  "
             f"CSS:{len(file_map['css'])}  HTML:{len(file_map['html'])}")
 
    # ── 2. Initialise graph store ─────────────────────────────────────────────
    graph = GraphStore()
 
    # ── 3. Parse each language ────────────────────────────────────────────────
    parsers = [
        ("Spring Boot / Java",  JavaParser(graph),        file_map["java"]),
        ("Angular / TypeScript", TypeScriptParser(graph), file_map["ts"]),
        ("Node.js / JavaScript", JavaScriptParser(graph), file_map["js"]),
        ("PostgreSQL / SQL",     SQLParser(graph),         file_map["sql"]),
        ("CSS / SCSS / LESS",    CSSParser(graph),         file_map["css"]),
        ("HTML / Templates",     HTMLParser(graph),        file_map["html"]),
    ]
 
    for label, parser, files in parsers:
        if not files:
            log.info(f"[{label}] — no files found, skipping")
            continue
        log.info(f"{Fore.GREEN}[{label}]{Style.RESET_ALL} Parsing {len(files)} file(s) …")
        for fpath in files:
            try:
                parser.parse(fpath)
            except Exception as exc:
                log.warning(f"  ✗ {fpath.name}: {exc}")
 
    # ── 4. Cross-layer relationship resolution ────────────────────────────────
    log.info(f"{Fore.YELLOW}Resolving cross-layer relationships …{Style.RESET_ALL}")
    graph.resolve_cross_references()
 
    # ── 5. Persist graph ──────────────────────────────────────────────────────
    graph.save(output, fmt=args.format)
    log.info(f"{Fore.CYAN}Graph saved → {output}{Style.RESET_ALL}")
 
    # ── 6. Print summary ──────────────────────────────────────────────────────
    SummaryReporter(graph).print()
 
 
if __name__ == "__main__":
    run(build_arg_parser().parse_args())