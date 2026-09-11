#!/usr/bin/env python3
"""
generate_studies_json.py — build the archive's static study index.

Contract (approved 2026-09-01):
  * generated automatically from the actual published study pages
  * excludes staged and unpublished studies
  * written atomically (temp file + os.replace) so the archive never reads
    a half-written manifest
  * carries only real, searchable fields: date, title, series, passage,
    pageType, url
  * preserves the archive's existing grouping (quarter = first '.' segment of
    series) and sorting (reverse chronological)
  * NO body text.  Body-text search is out of scope and must not be added here.

Usage:
    python3 tools/generate_studies_json.py --root . --out studies.json
    python3 tools/generate_studies_json.py --root . --out studies.json --check

--check verifies the existing manifest matches the published pages and exits
non-zero on drift.  Run it in the publish step after promotion.
"""

import argparse, json, os, re, sys, tempfile, hashlib
from datetime import date
from pathlib import Path

STUDY_FILE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})\.html$")

META = {
    "title":   re.compile(r'<meta\s+name="study-title"\s+content="([^"]*)"', re.I),
    "series":  re.compile(r'<meta\s+name="study-series"\s+content="([^"]*)"', re.I),
    "passage": re.compile(r'<meta\s+name="study-passage"\s+content="([^"]*)"', re.I),
}
# fallbacks
FIRST_VERSE_REF = re.compile(r'class="verse-ref"[^>]*>([^<]+)<', re.I)
BODY_CLASS      = re.compile(r'<body[^>]*class="([^"]*)"', re.I)
STAGED_MARKERS  = (
    'name="robots" content="noindex',
    'data-staged="true"',
    'name="publication-state" content="staged"',
)

ENTITY = {"&amp;": "&", "&middot;": "\u00b7", "&rsquo;": "\u2019",
          "&lsquo;": "\u2018", "&nbsp;": " ", "&quot;": '"', "&#39;": "'"}


def unescape(s):
    if s is None:
        return None
    for k, v in ENTITY.items():
        s = s.replace(k, v)
    return s.strip()


def page_type(text, d):
    """daily | sabbath | friday — from the body class, else the weekday."""
    m = BODY_CLASS.search(text)
    cls = m.group(1) if m else ""
    if "study-page--friday" in cls:
        return "friday"
    if "study-page--sabbath" in cls:
        return "sabbath"
    if d is not None:
        wd = d.weekday()          # Mon=0 .. Sat=5, Sun=6
        if wd == 5:
            return "sabbath"
        if wd == 4:
            return "friday"
    return "daily"


def is_staged(text):
    low = text.lower()
    return any(marker.lower() in low for marker in STAGED_MARKERS)


def collect(root):
    rows = []
    skipped = []
    root_path = Path(root)
    # Only root-level dated pages are public. Historical quarter files may be
    # retained elsewhere for editorial reference, but must never enter the
    # reader-facing archive manifest.
    pages = list(root_path.glob("*.html"))
    for path_obj in sorted(pages):
        m = STUDY_FILE.match(path_obj.name)
        if not m:
            continue
        name = path_obj.relative_to(root_path).as_posix()
        path = str(path_obj)
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()

        if is_staged(text):
            skipped.append((name, "staged"))
            continue

        d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        title = unescape(META["title"].search(text).group(1)) if META["title"].search(text) else None
        if not title:
            skipped.append((name, "no study-title meta"))
            continue

        series = META["series"].search(text)
        series = unescape(series.group(1)) if series else None

        passage = META["passage"].search(text)
        if passage:
            passage = unescape(passage.group(1))
        else:
            fv = FIRST_VERSE_REF.search(text)
            passage = unescape(fv.group(1)) if fv else None

        rows.append({
            "url": name,
            "date": d.isoformat(),
            "title": title,
            "series": series,
            "passage": passage,
            "pageType": page_type(text, d),
        })

    rows.sort(key=lambda r: r["date"], reverse=True)
    return rows, skipped


def payload(rows):
    return {
        "version": 1,
        "generated": date.today().isoformat(),
        "count": len(rows),
        "studies": rows,
    }


def write_atomic(path, data):
    body = json.dumps(data, ensure_ascii=False, indent=1) + "\n"
    dirname = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp = tempfile.mkstemp(dir=dirname, prefix=".studies-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(body)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)          # atomic on POSIX and Windows
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".", help="directory holding YYYY-MM-DD.html pages")
    ap.add_argument("--out", default="studies.json")
    ap.add_argument("--check", action="store_true",
                    help="verify the manifest matches the published pages; do not write")
    args = ap.parse_args()

    rows, skipped = collect(args.root)
    data = payload(rows)

    if args.check:
        if not os.path.exists(args.out):
            print("FAIL: %s does not exist" % args.out)
            return 1
        with open(args.out, "r", encoding="utf-8") as fh:
            have = json.load(fh)
        have_rows = have.get("studies", have if isinstance(have, list) else [])
        if have_rows != rows:
            hv = {r["url"] for r in have_rows}
            want = {r["url"] for r in rows}
            print("FAIL: manifest does not match published pages")
            for u in sorted(want - hv):
                print("  missing from manifest: %s" % u)
            for u in sorted(hv - want):
                print("  in manifest but not published: %s" % u)
            if want == hv:
                print("  same URLs, differing metadata \u2014 regenerate")
            return 1
        print("OK: manifest matches %d published studies" % len(rows))
        return 0

    digest = write_atomic(args.out, data)
    print("Wrote %s \u2014 %d studies, sha256 %s" % (args.out, len(rows), digest[:12]))
    for name, why in skipped:
        print("  skipped %s (%s)" % (name, why))
    return 0


if __name__ == "__main__":
    sys.exit(main())
