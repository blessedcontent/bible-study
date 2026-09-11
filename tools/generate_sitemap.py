#!/usr/bin/env python3
"""Generate the public sitemap from reader-accessible root pages."""
from __future__ import annotations

import argparse
from datetime import date
from pathlib import Path


def render(root: Path) -> str:
    pages = list(root.glob("*.html"))
    urls = sorted(path.relative_to(root).as_posix() for path in pages)
    base = "https://blessedcontent.github.io/bible-study"
    today = date.today().isoformat()
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for url in urls:
        lines.extend(("  <url>", f"    <loc>{base}/{url}</loc>",
                      f"    <lastmod>{today}</lastmod>", "  </url>"))
    lines.append("</urlset>")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--out", type=Path, default=Path("sitemap.xml"))
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    wanted = render(args.root)
    if args.check:
        if not args.out.is_file() or args.out.read_text(encoding="utf-8") != wanted:
            print("FAIL: sitemap does not match public pages")
            return 1
        print(f"OK: sitemap matches {wanted.count('<url>')} public pages")
        return 0
    args.out.write_text(wanted, encoding="utf-8", newline="\n")
    print(f"Wrote {args.out} - {wanted.count('<url>')} public pages")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
