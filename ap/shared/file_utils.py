"""Atomic file I/O utilities for safe JSON persistence."""

import json
import os
import tempfile
from pathlib import Path
from typing import Any, Optional


def atomic_json_write(path: str | Path, data: Any, indent: int = 2) -> None:
    """Write JSON atomically via tmp file + rename to prevent corruption."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    fd, tmp_path = tempfile.mkstemp(
        dir=str(path.parent),
        prefix=f".{path.name}.",
        suffix=".tmp",
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=indent)
        os.replace(tmp_path, str(path))
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def safe_json_read(path: str | Path, default: Any = None) -> Any:
    """Read JSON file, returning default on any error."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default
