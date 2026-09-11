#!/usr/bin/env python3
"""Mechanically move every deployable HTML page to the v5.1.0 asset contract."""

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
REPLACEMENTS = {
    "study-v5_0.css": "study-v5_1_0.css",
    "notifications-v5_1_0.js": "notifications-ea704e45.js",
    "notifications-a07bbd4d.js": "notifications-ea704e45.js",
    "notifications-c11ccc25.js": "notifications-ea704e45.js",
    "notifications-313a8f38.js": "notifications-ea704e45.js",
    "notifications.js": "notifications-ea704e45.js",
    "reader-controls-v5_1_0.js": "reader-controls-c8d1b1b6.js",
    "reader-controls-23a6a1ec.js": "reader-controls-c8d1b1b6.js",
    "reader-controls-7c315f58.js": "reader-controls-c8d1b1b6.js",
    "reader-controls-2be73d95.js": "reader-controls-c8d1b1b6.js",
    "reader-controls.js": "reader-controls-c8d1b1b6.js",
    "full-text-search-v5_1_0.js": "full-text-search-8eef895a.js",
    "full-text-search-d33d5579.js": "full-text-search-8eef895a.js",
    "full-text-search-5afba304.js": "full-text-search-8eef895a.js",
    "full-text-search-2a292c9e.js": "full-text-search-8eef895a.js",
    "full-text-search-223f5457.js": "full-text-search-8eef895a.js",
    "full-text-search-ab39215a.js": "full-text-search-8eef895a.js",
    "full-text-search.js": "full-text-search-8eef895a.js",
    "archive-search-v5_1_0.js": "archive-search-6fcac06e.js",
    "archive-search-54edbfa7.js": "archive-search-6fcac06e.js",
    "archive-search-569175a5.js": "archive-search-6fcac06e.js",
    "archive-search.js": "archive-search-6fcac06e.js",
    "privacy-controls-v5_1_0.js": "privacy-controls-248e6144.js",
    "privacy-controls-e56b76a4.js": "privacy-controls-248e6144.js",
    "privacy-controls-9efd3d6a.js": "privacy-controls-248e6144.js",
    "privacy-controls-c1f2393d.js": "privacy-controls-248e6144.js",
    "privacy-controls-f2e4b12f.js": "privacy-controls-248e6144.js",
    "privacy-controls-2da65aea.js": "privacy-controls-248e6144.js",
    "privacy-controls.js": "privacy-controls-248e6144.js",
    "verse-popover-525d6d19.js": "verse-popover-a4ca0f9c.js",
    "verse-popover-b72a8a80.js": "verse-popover-a4ca0f9c.js",
    "verse-popover-v5_1_0.js": "verse-popover-a4ca0f9c.js",
    "verse-popover.js?v=74b31b80": "verse-popover-a4ca0f9c.js",
    "verse-popover.js": "verse-popover-a4ca0f9c.js",
    "favicon-729135cb.png": "favicon-7591f3a3.png",
    "apple-touch-icon-729135cb.png": "apple-touch-icon-8ef286cd.png",
    "og-card.png": "og-card-2ff253a6.png",
    "Morning notification": "Daily reminder",
    "Get a morning reminder for each day’s study?": "Get a daily reminder? The default is 7:30 a.m. You can change the time in reader controls.",
    "Get a daily reminder at a time you choose?": "Get a daily reminder? The default is 7:30 a.m. You can change the time in reader controls.",
}


def deployable_pages():
    yield from sorted(ROOT.glob("*.html"))
    yield from sorted((ROOT / "staging").glob("*.html"))


def main():
    changed = 0
    pages = list(deployable_pages())
    for page in pages:
        original = page.read_text(encoding="utf-8")
        updated = original
        for old, new in REPLACEMENTS.items():
            updated = updated.replace(old, new)
        if updated != original:
            page.write_text(updated, encoding="utf-8", newline="")
            changed += 1

    failures = []
    forbidden_assets = (
        "study-v5_0.css", "notifications.js", "reader-controls.js",
        "full-text-search.js", "archive-search.js", "privacy-controls.js",
        "verse-popover.js", "favicon-729135cb.png",
        "apple-touch-icon-729135cb.png", "og-card.png",
    )
    for page in pages:
        text = page.read_text(encoding="utf-8")
        for asset in forbidden_assets:
            if f"assets/{asset}" in text:
                failures.append(f"{page.relative_to(ROOT)}: stale {asset}")
        for comment in re.findall(r"<!--(.*?)-->", text, flags=re.DOTALL):
            provenance = "_SOURCE:" in comment or comment.strip().lower().startswith("open graph")
            if not provenance and re.search(r"\b(?:review|sandbox)\b", comment, flags=re.IGNORECASE):
                failures.append(f"{page.relative_to(ROOT)}: deployable review/sandbox comment")
        for asset in re.findall(
            r'''(?:src|href|content)=["'](?:https://blessedcontent\.github\.io/bible-study/|/bible-study/|\./)?(assets/[^"'?#]+)''',
            text,
        ):
            if not (ROOT / asset).is_file():
                failures.append(f"{page.relative_to(ROOT)}: missing local {asset}")

    for name in ("about.html", "privacy.html", "scripture-sources.html", "corrections.html"):
        text = (ROOT / name).read_text(encoding="utf-8")
        if "—" in text or "&mdash;" in text or "&#8212;" in text or "&#x2014;" in text.lower():
            failures.append(f"{name}: trust pages must not contain em dashes")

    if failures:
        raise SystemExit("\n".join(failures))
    print(f"v5.1.0 migration verified across {len(pages)} pages; {changed} changed.")


if __name__ == "__main__":
    main()
