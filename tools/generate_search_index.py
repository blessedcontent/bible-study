#!/usr/bin/env python3
"""
generate_search_index.py — full-text search index for the archive.

Approved 2026-09-01 (option B: full text, lazily loaded).

Companion to generate_studies_json.py, NOT a replacement:

    studies.json        small, loaded on every archive visit, drives the list
    search-index.json   large, fetched only when a reader starts typing

Keeping them separate is the whole point. The archive page stays exactly as fast
as it is now; the body text is downloaded once, on demand, and cached.

Contract, mirroring the studies.json contract:
  * generated automatically from the actual published study pages
  * excludes staged and unpublished studies (same markers, same /staging/ path rule)
  * written atomically (temp file + os.replace)
  * contains only reader-visible prose — no markup, no scripts, no metadata
    duplication, no verse-popover JSON
  * --check verifies the index matches the published pages, for the publish step

Usage:
    python3 tools/generate_search_index.py --root . --out search-index.json
    python3 tools/generate_search_index.py --root . --out search-index.json --check
"""

import argparse, html, json, os, re, sys, tempfile
from datetime import date
from pathlib import Path

STUDY_FILE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})\.html$")

STAGED_MARKERS = (
    'name="robots" content="noindex',
    'data-staged="true"',
    'name="publication-state" content="staged"',
)

# Blocks whose text must never enter the index.
STRIP_BLOCKS = re.compile(
    r"<(script|style|template|noscript)\b[^>]*>.*?</\1>",
    re.I | re.S,
)
# Reader chrome: nav, menus, footers, the section rail. Indexing these would make
# every study match "scripture sources" and "all studies".
STRIP_CHROME = re.compile(
    r'<(header|footer|nav)\b[^>]*>.*?</\1>',
    re.I | re.S,
)
STRIP_BY_CLASS = re.compile(
    r'<(\w+)\b[^>]*class="[^"]*\b(appbar|menu|jumpbar|jumplist|site-footer|day-nav|skip-link|route-pending|staged-banner)\b[^"]*"[^>]*>.*?</\1>',
    re.I | re.S,
)
TAG = re.compile(r"<[^>]+>")
WS = re.compile(r"\s+")


def is_staged(text, path):
    if os.sep + "staging" + os.sep in path or "/staging/" in path.replace(os.sep, "/"):
        return True
    low = text.lower()
    return any(m.lower() in low for m in STAGED_MARKERS)


def extract_text(page):
    """Reader-visible prose only, as one normalised string."""
    body = page
    m = re.search(r"<main\b[^>]*>(.*?)</main>", page, re.I | re.S)
    if m:
        body = m.group(1)

    body = STRIP_BLOCKS.sub(" ", body)
    body = STRIP_CHROME.sub(" ", body)
    # run twice: nested chrome (a menu inside a header) survives one pass
    body = STRIP_BY_CLASS.sub(" ", body)
    body = STRIP_BY_CLASS.sub(" ", body)

    # keep block boundaries as spaces so words do not fuse across tags
    body = re.sub(r"<(p|div|section|li|h[1-6]|br|figcaption|blockquote)\b[^>]*>", " ", body, flags=re.I)
    body = TAG.sub("", body)
    body = html.unescape(body)
    body = body.replace("\u00a0", " ")
    return WS.sub(" ", body).strip()


def collect(root):
    docs = {}
    skipped = []
    root_path = Path(root)
    # The public reader archive consists only of root-level dated pages.
    pages = list(root_path.glob("*.html"))
    for path_obj in sorted(pages):
        if not STUDY_FILE.match(path_obj.name):
            continue
        name = path_obj.relative_to(root_path).as_posix()
        path = str(path_obj)
        with open(path, "r", encoding="utf-8") as fh:
            page = fh.read()
        if is_staged(page, path):
            skipped.append((name, "staged"))
            continue
        text = extract_text(page)
        if len(text) < 200:
            skipped.append((name, "no extractable prose (%d chars)" % len(text)))
            continue
        docs[name] = text
    return docs, skipped


def payload(docs):
    return {
        "version": 1,
        "generated": date.today().isoformat(),
        "count": len(docs),
        # url -> reader-visible prose
        "docs": docs,
    }


def write_atomic(path, data):
    # No indent: this file is machine-read only and indentation would add ~15%.
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n"
    dirname = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp = tempfile.mkstemp(dir=dirname, prefix=".search-index-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(body)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return len(body.encode("utf-8"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--out", default="search-index.json")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    docs, skipped = collect(args.root)

    if args.check:
        if not os.path.exists(args.out):
            print("FAIL: %s does not exist" % args.out)
            return 1
        with open(args.out, "r", encoding="utf-8") as fh:
            have = json.load(fh).get("docs", {})
        if set(have) != set(docs):
            print("FAIL: index does not match published pages")
            for u in sorted(set(docs) - set(have)):
                print("  missing from index: %s" % u)
            for u in sorted(set(have) - set(docs)):
                print("  in index but not published: %s" % u)
            return 1
        stale = [u for u in docs if have[u] != docs[u]]
        if stale:
            print("FAIL: %d page(s) changed since the index was built" % len(stale))
            for u in stale[:10]:
                print("  stale: %s" % u)
            return 1
        print("OK: index matches %d published studies" % len(docs))
        return 0

    size = write_atomic(args.out, payload(docs))
    print("Wrote %s - %d studies, %.1f KB" % (args.out, len(docs), size / 1024.0))
    if size > 3_000_000:
        print("WARNING: index exceeds 3 MB. Consider trimming or moving to a digest index.")
    for name, why in skipped:
        print("  skipped %s (%s)" % (name, why))
    return 0


if __name__ == "__main__":
    sys.exit(main())
