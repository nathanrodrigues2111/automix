from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any

import paths

_DB_LOCK = threading.Lock()
_DB_PATH = paths.DB_PATH


def _ensure_dirs() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)


def _conn() -> sqlite3.Connection:
    _ensure_dirs()
    c = sqlite3.connect(str(_DB_PATH), check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


_TRACK_META_SQL = """
CREATE TABLE IF NOT EXISTS track_meta (
    file_hash TEXT PRIMARY KEY,
    title TEXT,
    artist TEXT,
    source_url TEXT,
    video_id TEXT,
    created_at TEXT
);
"""


def init_db() -> None:
    with _DB_LOCK, _conn() as c:
        c.executescript(_TRACK_META_SQL)
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS analyses (
                file_hash TEXT PRIMARY KEY,
                json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS renders (
                id TEXT PRIMARY KEY,
                output_path TEXT NOT NULL,
                created_at TEXT NOT NULL,
                config_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                slug TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                config_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS app_state (
                key TEXT PRIMARY KEY,
                value TEXT
            );
            """
        )
        # Older databases predate the `slug` column (projects used to mean a
        # saved render config). Add it in place so nothing is lost.
        cols = {r["name"] for r in c.execute("PRAGMA table_info(projects)").fetchall()}
        if "slug" not in cols:
            c.execute("ALTER TABLE projects ADD COLUMN slug TEXT")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_analysis(file_hash: str) -> dict[str, Any] | None:
    with _DB_LOCK, _conn() as c:
        row = c.execute(
            "SELECT json FROM analyses WHERE file_hash = ?", (file_hash,)
        ).fetchone()
        return json.loads(row["json"]) if row else None


def put_analysis(file_hash: str, data: dict[str, Any]) -> None:
    with _DB_LOCK, _conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO analyses (file_hash, json, created_at) VALUES (?, ?, ?)",
            (file_hash, json.dumps(data), _now_iso()),
        )


def rekey_file_hash(old: str, new: str) -> None:
    """Re-point analysis + track-meta rows at a file's new hash. The hash is
    path-based, so moving a file (e.g. videos/ -> videos/imports/) orphans
    its rows unless they're re-keyed."""
    with _DB_LOCK, _conn() as c:
        c.executescript(_TRACK_META_SQL)
        c.execute(
            "UPDATE OR IGNORE analyses SET file_hash = ? WHERE file_hash = ?",
            (new, old),
        )
        c.execute("DELETE FROM analyses WHERE file_hash = ?", (old,))
        c.execute(
            "UPDATE OR IGNORE track_meta SET file_hash = ? WHERE file_hash = ?",
            (new, old),
        )
        c.execute("DELETE FROM track_meta WHERE file_hash = ?", (old,))


def put_track_meta(
    file_hash: str,
    title: str,
    artist: str = "",
    source_url: str = "",
    video_id: str = "",
) -> None:
    with _DB_LOCK, _conn() as c:
        # Create the table on the fly so old databases pick it up.
        c.executescript(_TRACK_META_SQL)
        c.execute(
            "INSERT OR REPLACE INTO track_meta "
            "(file_hash, title, artist, source_url, video_id, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (file_hash, title, artist, source_url, video_id, _now_iso()),
        )


def get_track_meta(file_hash: str) -> dict[str, Any] | None:
    with _DB_LOCK, _conn() as c:
        try:
            row = c.execute(
                "SELECT file_hash, title, artist, source_url, video_id, created_at "
                "FROM track_meta WHERE file_hash = ?",
                (file_hash,),
            ).fetchone()
        except sqlite3.OperationalError:
            # Old database without the table yet.
            return None
        if not row:
            return None
        return {
            "file_hash": row["file_hash"],
            "title": row["title"] or "",
            "artist": row["artist"] or "",
            "source_url": row["source_url"] or "",
            "video_id": row["video_id"] or "",
            "created_at": row["created_at"] or "",
        }


def add_render(render_id: str, output_path: str, config: dict[str, Any]) -> dict[str, Any]:
    created = _now_iso()
    with _DB_LOCK, _conn() as c:
        c.execute(
            "INSERT INTO renders (id, output_path, created_at, config_json) VALUES (?, ?, ?, ?)",
            (render_id, output_path, created, json.dumps(config)),
        )
    return {"id": render_id, "output_path": output_path, "created_at": created, "config": config}


def list_renders() -> list[dict[str, Any]]:
    with _DB_LOCK, _conn() as c:
        rows = c.execute(
            "SELECT id, output_path, created_at, config_json FROM renders ORDER BY created_at DESC"
        ).fetchall()
        return [
            {
                "id": r["id"],
                "output_path": r["output_path"],
                "created_at": r["created_at"],
                "config": json.loads(r["config_json"]),
            }
            for r in rows
        ]


def _project_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "slug": row["slug"] or "",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "config": json.loads(row["config_json"]),
    }


def add_project(
    project_id: str, name: str, slug: str, config: dict[str, Any]
) -> dict[str, Any]:
    now = _now_iso()
    with _DB_LOCK, _conn() as c:
        c.execute(
            "INSERT INTO projects (id, name, slug, created_at, updated_at, config_json) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (project_id, name, slug, now, now, json.dumps(config)),
        )
    return {
        "id": project_id,
        "name": name,
        "slug": slug,
        "created_at": now,
        "updated_at": now,
        "config": config,
    }


def get_project(project_id: str) -> dict[str, Any] | None:
    with _DB_LOCK, _conn() as c:
        row = c.execute(
            "SELECT id, name, slug, created_at, updated_at, config_json "
            "FROM projects WHERE id = ?",
            (project_id,),
        ).fetchone()
        return _project_row(row) if row else None


def list_projects() -> list[dict[str, Any]]:
    with _DB_LOCK, _conn() as c:
        rows = c.execute(
            "SELECT id, name, slug, created_at, updated_at, config_json "
            "FROM projects ORDER BY updated_at DESC"
        ).fetchall()
        return [_project_row(r) for r in rows]


def rename_project(project_id: str, name: str) -> None:
    with _DB_LOCK, _conn() as c:
        c.execute(
            "UPDATE projects SET name = ?, updated_at = ? WHERE id = ?",
            (name, _now_iso(), project_id),
        )


def update_project_config(project_id: str, config: dict[str, Any]) -> None:
    with _DB_LOCK, _conn() as c:
        c.execute(
            "UPDATE projects SET config_json = ?, updated_at = ? WHERE id = ?",
            (json.dumps(config), _now_iso(), project_id),
        )


def touch_project(project_id: str) -> None:
    """Bump updated_at so the most recently opened project sorts first."""
    with _DB_LOCK, _conn() as c:
        c.execute(
            "UPDATE projects SET updated_at = ? WHERE id = ?",
            (_now_iso(), project_id),
        )


def delete_project(project_id: str) -> None:
    with _DB_LOCK, _conn() as c:
        c.execute("DELETE FROM projects WHERE id = ?", (project_id,))


def get_app_state(key: str) -> str | None:
    with _DB_LOCK, _conn() as c:
        try:
            row = c.execute(
                "SELECT value FROM app_state WHERE key = ?", (key,)
            ).fetchone()
        except sqlite3.OperationalError:
            return None
        return row["value"] if row else None


def set_app_state(key: str, value: str) -> None:
    with _DB_LOCK, _conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)",
            (key, value),
        )


def get_active_project_id() -> str | None:
    return get_app_state("active_project_id")


def set_active_project_id(project_id: str) -> None:
    set_app_state("active_project_id", project_id)
