#!/usr/bin/env python3
"""Fail closed when the deployable v5.1.0 package drifts from its asset contract."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / "assets"
MANIFEST_PATH = ROOT / "asset-manifest-v5_1_0.json"
ROLLBACK_ASSETS = {
    "study-v4_9.css",
    "study-v5_0.css",
    "study-watermark-ae706e30.png",
    "cross-light-soft.svg",
}
TRUST_PAGES = (
    "about.html",
    "privacy.html",
    "scripture-sources.html",
    "corrections.html",
)
FORBIDDEN_ACTIVE_NAMES = {
    "archive-search.js",
    "full-text-search.js",
    "notifications.js",
    "privacy-controls.js",
    "reader-controls.js",
    "verse-popover.js",
    "study-v5_0.css",
    "favicon-729135cb.png",
    "favicon.png",
    "apple-touch-icon-729135cb.png",
    "apple-touch-icon.png",
    "og-card.png",
}
SECRET_PATTERNS = {
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "GitHub token": re.compile(r"\b(?:github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,})\b"),
    "Slack token": re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"),
    "Stripe secret": re.compile(r"\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b"),
}
TEXT_SUFFIXES = {
    ".css", ".html", ".js", ".json", ".md", ".py", ".txt", ".xml", ".yml", ".yaml"
}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def deployable_pages() -> list[Path]:
    pages = sorted(ROOT.glob("*.html"))
    pages.extend(sorted((ROOT / "staging").glob("*.html")))
    return pages


def main() -> int:
    failures: list[str] = []
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if manifest.get("contractVersion") != "5.1.0":
        failures.append("asset manifest contractVersion is not 5.1.0")

    assets = manifest.get("assets")
    if not isinstance(assets, dict) or not assets:
        failures.append("asset manifest has no assets")
        assets = {}

    manifest_names: set[str] = set()
    for relative, expected in assets.items():
        path = ROOT / relative
        if path.parent != ASSET_DIR:
            failures.append(f"manifest entry is outside assets/: {relative}")
            continue
        manifest_names.add(path.name)
        if not path.is_file():
            failures.append(f"manifest asset is missing: {relative}")
        elif digest(path) != expected:
            failures.append(f"manifest hash mismatch: {relative}")

    actual_names = {path.name for path in ASSET_DIR.iterdir() if path.is_file()}
    expected_names = manifest_names | ROLLBACK_ASSETS
    for name in sorted(actual_names - expected_names):
        failures.append(f"undocumented asset outside active or rollback set: assets/{name}")
    for name in sorted(ROLLBACK_ASSETS - actual_names):
        failures.append(f"documented rollback dependency is missing: assets/{name}")

    pages = deployable_pages()
    if not pages:
        failures.append("no deployable HTML pages found")
    asset_reference = re.compile(
        r'''(?:src|href|content)=["'](?:https://blessedcontent\.github\.io/bible-study/|/bible-study/|\./)?(assets/[^"'?#]+)'''
    )
    for page in pages:
        text = page.read_text(encoding="utf-8")
        for relative in asset_reference.findall(text):
            if not (ROOT / relative).is_file():
                failures.append(f"{page.relative_to(ROOT)} references missing {relative}")
        for name in FORBIDDEN_ACTIVE_NAMES:
            if f"assets/{name}" in text:
                failures.append(f"{page.relative_to(ROOT)} references superseded assets/{name}")

    for name in TRUST_PAGES:
        text = (ROOT / name).read_text(encoding="utf-8")
        lower = text.lower()
        if "—" in text or "&mdash;" in lower or "&#8212;" in lower or "&#x2014;" in lower:
            failures.append(f"{name} contains an em dash")

    service_worker = (ROOT / "sw.js").read_text(encoding="utf-8")
    for relative in re.findall(r"['\"](/bible-study/assets/[^'\"]+)['\"]", service_worker):
        local = ROOT / relative.removeprefix("/bible-study/")
        if not local.is_file():
            failures.append(f"sw.js pre-caches missing {relative}")
        elif local.name not in manifest_names:
            failures.append(f"sw.js pre-caches non-current asset {relative}")

    forbidden_secret_files = (
        list(ROOT.glob(".env*"))
        + list(ROOT.rglob("*service-account*.json"))
        + list(ROOT.rglob("*firebase-adminsdk*.json"))
    )
    for path in forbidden_secret_files:
        if ".git" not in path.parts:
            failures.append(f"secret-bearing file must not deploy: {path.relative_to(ROOT)}")
    for path in ROOT.rglob("*"):
        if not path.is_file() or ".git" in path.parts or path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for label, pattern in SECRET_PATTERNS.items():
            if pattern.search(text):
                failures.append(f"possible {label} in {path.relative_to(ROOT)}")

    if failures:
        print("v5.1.0 release validation: FAIL")
        for failure in failures:
            print(f"  [FAIL] {failure}")
        return 1

    print(
        "v5.1.0 release validation: PASS "
        f"({len(pages)} pages, {len(manifest_names)} active assets, "
        f"{len(ROLLBACK_ASSETS)} rollback assets)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
