"""Regression coverage for HTML metadata becoming plain-text archive data."""
import html
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import generate_studies_json as generator


class StudyIndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def page(self, title, *, series="A series", passage="Romans 1:19–20",
             name="2026-10-01.html", extra="", fallback=False):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        reference = (f'<span class="verse-ref">{passage}</span>' if fallback else
                     f'<meta name="study-passage" content="{passage}">')
        path.write_text(
            f'<meta name="study-title" content="{title}">\n'
            f'<meta name="study-series" content="{series}">\n'
            f'{reference}\n{extra}', encoding="utf-8")

    def test_apostrophes_in_all_metadata_fields(self):
        for entity, character in (("&#x27;", "'"), ("&#X27;", "'"),
                                  ("&#39;", "'"), ("&apos;", "'"),
                                  ("&rsquo;", "’"), ("&#8217;", "’"),
                                  ("&#x2019;", "’")):
            with self.subTest(entity=entity):
                self.page(f"God{entity}s Spokespeople",
                          series=f"God{entity}s Word", passage=f"God{entity}s promise")
                rows, skipped = generator.collect(self.root)
                self.assertEqual(skipped, [])
                self.assertEqual(rows[0]["title"], f"God{character}s Spokespeople")
                self.assertEqual(rows[0]["series"], f"God{character}s Word")
                self.assertEqual(rows[0]["passage"], f"God{character}s promise")

    def test_assembler_escaping_round_trips_through_json(self):
        title = "God's Spokespeople"
        series = 'The Gift of Prophecy · Lesson 1, The Creator Speaks · Day 6 of 7'
        self.page(html.escape(title), series=html.escape(series))
        rows, _ = generator.collect(self.root)
        output = self.root / "studies.json"
        generator.write_atomic(output, generator.payload(rows))
        result = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["studies"][0], {
            "url": "2026-10-01.html", "date": "2026-10-01", "title": title,
            "series": series, "passage": "Romans 1:19–20", "pageType": "daily",
        })

    def test_named_numeric_and_unicode_text(self):
        self.page("  Faith &amp; Love &mdash; &quot;Caf&eacute;&quot; &#x271D;  ",
                  series="God’s&nbsp;Word &middot; Lesson&#160;1",
                  passage="Romans 1:19&#x2013;20", fallback=True)
        row = generator.collect(self.root)[0][0]
        self.assertEqual(row["title"], 'Faith & Love — "Café" ✝')
        self.assertEqual(row["series"], "God’s Word · Lesson 1")
        self.assertEqual(row["passage"], "Romans 1:19–20")

    def test_decodes_one_html_layer_and_preserves_literal_text(self):
        # The JSON contract is plain text. Repeated decoding changes the
        # author's literal entity examples and differs from browser rendering.
        title = 'Literal &amp; and &#x27; with <brackets>, "quotes", and God’s word'
        self.page(html.escape(title))
        self.assertEqual(generator.collect(self.root)[0][0]["title"], title)

    def test_unpublished_pages_stay_excluded_and_sorting_is_preserved(self):
        self.page("Today")
        self.page("Yesterday", name="2026-09-30.html")
        self.page("Future", name="staging/2026-10-02.html")
        self.page("Archived", name="archive/2026-09-29.html")
        for day, marker in (("02", '<meta name="robots" content="noindex">'),
                            ("03", '<meta name="publication-state" content="staged">'),
                            ("04", '<body data-staged="true">')):
            self.page("Not public", name=f"2026-10-{day}.html", extra=marker)
        rows, skipped = generator.collect(self.root)
        self.assertEqual([row["title"] for row in rows], ["Today", "Yesterday"])
        self.assertEqual(len(skipped), 3)

    def test_check_rejects_the_original_encoded_title(self):
        self.page("God&#x27;s Spokespeople")
        output = self.root / "studies.json"
        rows, _ = generator.collect(self.root)
        rows[0]["title"] = "God&#x27;s Spokespeople"
        generator.write_atomic(output, generator.payload(rows))
        command = [sys.executable, generator.__file__, "--root", str(self.root),
                   "--out", str(output)]
        result = subprocess.run(command + ["--check"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        subprocess.run(command, check=True, capture_output=True)
        result = subprocess.run(command + ["--check"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
