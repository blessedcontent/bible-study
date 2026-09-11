#!/usr/bin/env python3
"""Finalize promoted studies and refresh adjacent-day navigation.

Run after moving a dated page from staging to the site root and before
regenerating studies.json, search-index.json and sitemap.xml.
"""
from __future__ import annotations

import argparse
import html
import re
from datetime import date, timedelta
from pathlib import Path

STUDY = re.compile(r"^\d{4}-\d{2}-\d{2}\.html$")
TITLE = re.compile(r'<meta\s+name="study-title"\s+content="([^"]+)"', re.I)
DAY_NAV = re.compile(r'<nav class="day-nav" aria-label="Nearby studies">.*?</nav>', re.S)
STAGED_BANNER = re.compile(r'\s*<div class="staged-banner"[^>]*>.*?</div>', re.S)
STAGED_META = re.compile(r'\s*<meta\s+name="(?:publication-state|robots)"[^>]*>', re.I)


def title(path: Path) -> str | None:
    if not path.exists():
        return None
    match = TITLE.search(path.read_text(encoding="utf-8"))
    return html.unescape(match.group(1)).strip() if match else None


def item(root: Path, value: date, direction: str) -> str:
    filename = value.isoformat() + ".html"
    adjacent = title(root / filename)
    url = f"/bible-study/{filename}"
    kicker = f"← {value.strftime('%A')}" if direction == "previous" else f"{value.strftime('%A')} →"
    if adjacent:
        return (
            f'<a class="day-nav-item" href="{url}">'
            f'<span class="day-nav-kicker">{kicker}</span>'
            f'<span class="day-nav-title">{html.escape(adjacent)}</span></a>'
        )
    return (
        '<div class="day-nav-item is-pending" aria-disabled="true">'
        f'<span class="day-nav-kicker">{kicker}</span>'
        '<span class="day-nav-title">Not published yet</span></div>'
    )


def update(root: Path, path: Path) -> None:
    value = date.fromisoformat(path.stem)
    text = path.read_text(encoding="utf-8")
    text = STAGED_META.sub("", text)
    text = text.replace(' data-staged="true"', "")
    text = STAGED_BANNER.sub("", text)
    nav = (
        '<nav class="day-nav" aria-label="Nearby studies">'
        + item(root, value - timedelta(days=1), "previous")
        + item(root, value + timedelta(days=1), "next")
        + '</nav>'
    )
    if DAY_NAV.search(text):
        text = DAY_NAV.sub(nav, text, count=1)
    else:
        text = text.replace('</div>\n<footer class="site-footer">', '</div>\n' + nav + '\n<footer class="site-footer">', 1)
    path.write_text(text, encoding="utf-8", newline="\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("."))
    args = parser.parse_args()
    pages = sorted(path for path in args.root.iterdir() if STUDY.fullmatch(path.name))
    for path in pages:
        update(args.root, path)
    print(f"Refreshed navigation and publication state for {len(pages)} studies")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
