"""
FileScanner
-----------
Walks a project tree and buckets every source file by language.
"""
 
from pathlib import Path
from typing  import Dict, List, Set
 
 
EXT_MAP: Dict[str, str] = {
    ".java": "java",
    ".ts":   "ts",
    ".tsx":  "ts",
    ".js":   "js",
    ".mjs":  "js",
    ".cjs":  "js",
    ".sql":  "sql",
    ".css":  "css",
    ".scss": "css",
    ".sass": "css",
    ".less": "css",
    ".html": "html",
    ".htm":  "html",
}
 
 
class FileScanner:
    def __init__(self, root: Path, skip_dirs: Set[str] | None = None):
        self.root      = root
        self.skip_dirs = skip_dirs or set()
 
    # ------------------------------------------------------------------
    def scan(self) -> Dict[str, List[Path]]:
        result: Dict[str, List[Path]] = {lang: [] for lang in set(EXT_MAP.values())}
 
        for path in self.root.rglob("*"):
            # Skip unwanted directory subtrees
            if any(part in self.skip_dirs for part in path.parts):
                continue
            # Skip test files (optional — remove if you want test coverage)
            if path.stem.endswith(("_test", ".spec", ".test", "Test", "Spec")):
                continue
            lang = EXT_MAP.get(path.suffix.lower())
            if lang:
                result[lang].append(path)
 
        return result