#!/usr/bin/env python3
"""Download every model listed in src-backend/src/models.rs into a folder.

The "with models" release build ships these files inside the app (see
src-backend/tauri.models.conf.json). models.rs stays the single source of
truth for URLs and SHA-256 hashes, so this script reads them from there.

Usage: python scripts/fetch-models.py [--dry-run] [DEST] [MODEL_ID ...]
DEST defaults to src-backend/bundled-models. Files already present with the
right hash are kept.
"""

import argparse
import hashlib
import re
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS_RS = ROOT / "src-backend" / "src" / "models.rs"
DEFAULT_DEST = ROOT / "src-backend" / "bundled-models"
CHUNK_BYTES = 1 << 20
SPEC_BLOCK = re.compile(r"ModelSpec \{(.*?)\n    \},", re.S)
FIELD = re.compile(r'^\s*(id|url|sha256|file): (?:"([^"]*)"|([A-Z_]+)),', re.M)
ID_CONST = re.compile(r'^pub const ([A-Z_]+): &str = "([^"]*)";', re.M)


class FetchError(Exception):
    """A model could not be read from models.rs or downloaded intact."""


@dataclass(frozen=True)
class ModelFile:
    """One model's download details, as pinned in models.rs."""

    id: str
    url: str
    sha256: str
    file: str


class ModelRegistry:
    """Reads the model list out of models.rs."""

    def __init__(self, source: Path) -> None:
        self._source = source

    def load(self) -> list[ModelFile]:
        """Parse every ModelSpec; raises FetchError if one is incomplete."""
        text = self._source.read_text(encoding="utf-8")
        consts = dict(ID_CONST.findall(text))
        models = [self._parse(block, consts) for block in SPEC_BLOCK.findall(text)]
        if not models:
            raise FetchError(f"no ModelSpec entries found in {self._source}")
        return models

    @staticmethod
    def _parse(block: str, consts: dict[str, str]) -> ModelFile:
        fields = {name: literal or consts.get(const, "") for name, literal, const in FIELD.findall(block)}
        missing = {"id", "url", "sha256", "file"} - {k for k, v in fields.items() if v}
        if missing:
            raise FetchError(f"ModelSpec missing {sorted(missing)}: {block.strip()[:80]}")
        return ModelFile(**fields)


class ModelDownloader:
    """Downloads model files into a folder and checks their SHA-256."""

    def __init__(self, dest: Path) -> None:
        self._dest = dest

    def fetch(self, model: ModelFile) -> None:
        """Download one model unless an intact copy is already there."""
        path = self._dest / model.file
        if path.exists() and self._sha256(path) == model.sha256:
            print(f"{model.id}: already present")
            return
        self._dest.mkdir(parents=True, exist_ok=True)
        part = path.with_suffix(path.suffix + ".part")
        print(f"{model.id}: downloading {model.url}", flush=True)
        with urllib.request.urlopen(model.url) as response, part.open("wb") as out:
            while chunk := response.read(CHUNK_BYTES):
                out.write(chunk)
        digest = self._sha256(part)
        if digest != model.sha256:
            part.unlink()
            raise FetchError(f"{model.id}: sha256 {digest}, expected {model.sha256}")
        part.replace(path)

    @staticmethod
    def _sha256(path: Path) -> str:
        hasher = hashlib.sha256()
        with path.open("rb") as f:
            while chunk := f.read(CHUNK_BYTES):
                hasher.update(chunk)
        return hasher.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("dest", nargs="?", type=Path, default=DEFAULT_DEST)
    parser.add_argument("ids", nargs="*", help="only these model ids (default: all)")
    parser.add_argument("--dry-run", action="store_true", help="list the models without downloading")
    args = parser.parse_args()

    models = ModelRegistry(MODELS_RS).load()
    unknown = set(args.ids) - {m.id for m in models}
    if unknown:
        parser.error(f"unknown model ids: {sorted(unknown)}")
    selected = [m for m in models if not args.ids or m.id in args.ids]
    downloader = ModelDownloader(args.dest)
    for model in selected:
        if args.dry_run:
            print(f"{model.id}\t{model.file}\t{model.url}")
        else:
            downloader.fetch(model)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except FetchError as err:
        sys.exit(f"error: {err}")
