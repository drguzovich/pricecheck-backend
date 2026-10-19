#!/usr/bin/env python3
"""Copy a finalized frontend working copy into the backend's bundled PWA.

Usage: python3 scripts/sync-pwa.py /absolute/path/to/frontend
Copies project source only; never credentials, dependencies, build outputs or Git.
Existing extra documentation is preserved. Use before the backend release build.
"""
from pathlib import Path
import shutil
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: python3 scripts/sync-pwa.py FRONTEND_DIRECTORY")
source = Path(sys.argv[1]).resolve()
target = Path(__file__).resolve().parents[1] / "pwa"
if not (source / "src/app/layout.tsx").is_file():
    raise SystemExit("Expected the audited Next.js frontend")
excluded = {".git", ".next", "node_modules", ".project-config.json", "render.yaml", "Dockerfile", "app.config.ts"}
for entry in source.iterdir():
    if entry.name in excluded or (entry.name.startswith(".env") and entry.name != ".env.example") or entry.name.endswith(".tsbuildinfo"):
        continue
    destination = target / entry.name
    if entry.is_dir():
        shutil.copytree(entry, destination, dirs_exist_ok=True)
    else:
        shutil.copy2(entry, destination)
# public/robots.txt replaces the previous generator; both cannot own the URL.
old_robots = target / "src/app/robots.ts"
if (target / "public/robots.txt").exists() and old_robots.exists():
    old_robots.unlink()
print(f"Synced frontend source from {source} to {target}")
