import contextlib
from datetime import date
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
from threading import Thread
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import urlopen

from release import (PUBLIC_FILES, PUBLIC_DIRECTORIES, build_site, commit_release,
                     deploy_needed, prepare, prepare_working, promotion, runway)

SOURCE = Path(__file__).resolve().parents[1]


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='release-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / 'source'
        self.root.mkdir()
        for name in PUBLIC_FILES:
            (self.root / name).write_text('reader file', encoding='utf-8')
        for name in PUBLIC_DIRECTORIES:
            (self.root / name).mkdir()
            (self.root / name / 'reader.txt').write_text('reader asset')
        (self.root / '2026-11-06.html').write_text('<head><meta name="study-title" content="Test"></head>')
        (self.root / 'staging').mkdir()

    def staged(self, *dates):
        for value in dates:
            (self.root / 'staging' / f'{value}.html').write_text('staged lesson')

    def test_runway_stops_at_first_gap(self):
        self.staged('2026-11-07', '2026-11-09', '2026-11-10')
        self.assertEqual(runway(self.root, '2026-11-06'), {
            'start': '2026-11-07', 'consecutive_days': 1, 'first_missing': '2026-11-08'})

    def test_runway_reports_zero_and_ignores_obsolete_staging(self):
        self.staged('2026-11-05', '2026-11-08')
        self.assertEqual(runway(self.root, '2026-11-06')['consecutive_days'], 0)
        self.assertEqual(runway(self.root, '2026-11-06')['first_missing'], '2026-11-07')

    def test_runway_skips_consecutive_published_dates(self):
        (self.root / '2026-11-07.html').write_text('published')
        self.staged('2026-11-08', '2026-11-09', '2026-11-10')
        self.assertEqual(runway(self.root, '2026-11-06')['consecutive_days'], 3)

    def test_committed_lesson_retries_deployment_until_live(self):
        state = Path(self.temporary.name) / 'state'
        state.mkdir()
        dates = {'today': '2026-11-06', 'target': '2026-11-06'}
        for event, ready in [('schedule', False), ('schedule', False), ('workflow_dispatch', False), ('schedule', True)]:
            probe = lambda root, target: {'live': ready, 'url': f'https://example.test/{target}.html', 'reason': 'simulated deploy state'}
            with patch('release.build_site', return_value=1):
                result = prepare_working(self.root, event, dates, probe, state)
            self.assertFalse(result['promoted'])
            self.assertEqual(result['would_deploy'], not ready)
            self.assertTrue((self.root / '2026-11-06.html').is_file())

    def test_push_still_deploys_reader_changes(self):
        self.assertTrue(deploy_needed('push', False, True))
        self.assertTrue(deploy_needed('schedule', False, False))
        self.assertFalse(deploy_needed('schedule', False, True))

    def test_failed_deploy_after_promotion_recovers_without_another_promotion(self):
        self.staged('2026-11-07', '2026-11-08')
        dates = {'today': '2026-11-06', 'target': '2026-11-07'}
        state = Path(self.temporary.name)
        ready = False
        def probe(root, target):
            return {'live': ready or target == dates['today'], 'url': target, 'reason': 'simulated failed deploy'}
        with patch('release.refresh', return_value=['2026-11-06.html', '2026-11-07.html']) as refresh, patch('release.build_site', return_value=1):
            first = prepare_working(self.root, 'schedule', dates, probe, state)
            self.assertTrue(first['promoted'])
            self.assertTrue(first['would_deploy'])
            # The commit succeeded but the simulated deployment did not.
            second = prepare_working(self.root, 'schedule', dates, probe, state)
            self.assertFalse(second['promoted'])
            self.assertTrue(second['would_deploy'])
            refresh.assert_called_once()
            ready = True
            third = prepare_working(self.root, 'schedule', dates, probe, state)
            self.assertFalse(third['would_deploy'])

    def test_retry_also_checks_today_after_the_cutoff(self):
        (self.root / '2026-11-07.html').write_text('published')
        state = Path(self.temporary.name)
        probe = lambda root, target: {'live': target == '2026-11-07', 'url': target, 'reason': 'simulated'}
        with patch('release.build_site', return_value=1):
            result = prepare_working(self.root, 'schedule', {'today': '2026-11-06', 'target': '2026-11-07'}, probe, state)
        self.assertTrue(result['would_deploy'])

    def test_dry_run_isolates_promotion_build_and_runway(self):
        self.staged('2026-11-07', '2026-11-08', '2026-11-10')
        before = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        def fake_refresh(root, paths_file):
            (root / '2026-11-06.html').write_text('updated adjacent navigation')
            return ['2026-11-06.html', '2026-11-07.html']
        with patch('release.context', return_value={'today': '2026-11-06', 'target': '2026-11-07'}), patch('release.refresh', side_effect=fake_refresh):
            result = prepare(self.root, 'workflow_dispatch', True, probe=lambda root, target: {
                'live': False, 'url': target, 'reason': 'simulated HTTP 404'})
        self.assertTrue(result['promoted'])
        self.assertTrue(result['would_deploy'])
        self.assertFalse(result['deploy'])
        self.assertEqual(result['runway']['consecutive_days'], 1)
        self.assertEqual(result['runway']['first_missing'], '2026-11-09')
        after = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)

    def test_exact_allowlist_excludes_private_repository_paths(self):
        self.staged('2026-11-07')
        for relative in ('tools/generate_sitemap.py', 'scripts/hidden.js', 'README.md', '_config.yml',
                         '.github/workflows/test.yml', 'assets/__pycache__/test.pyc', 'assets/.hidden',
                         'asset-manifest-v5_1_0.json'):
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('excluded')
        output = Path(self.temporary.name) / 'site'
        build_site(self.root, output)
        expected = set(PUBLIC_FILES) | {'2026-11-06.html', 'assets/reader.txt', 'icons/reader.txt'}
        actual = {p.relative_to(output).as_posix() for p in output.rglob('*') if p.is_file()}
        self.assertEqual(actual, expected)
        for name in expected:
            self.assertEqual((output / name).read_bytes(), (self.root / name).read_bytes())
        with self.assertRaises(ValueError):
            build_site(self.root, output)  # Never retain a stale artifact's extra files.

    def test_missing_required_public_file_fails_build(self):
        (self.root / 'sw.js').unlink()
        with self.assertRaises(ValueError):
            build_site(self.root, Path(self.temporary.name) / 'site')

    @unittest.skipIf(os.environ.get('DBS_SKIP_HTTP_TESTS') == '1', 'Local executor denies loopback HTTP; CI runs this check')
    def test_built_http_site_serves_reader_files_and_returns_404_for_exclusions(self):
        self.staged('2026-11-07')
        for relative in ('README.md', 'tools/generate_sitemap.py', 'scripts/send-notification.js'):
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('excluded')
        webroot = Path(self.temporary.name) / 'web'
        build_site(self.root, webroot / 'bible-study')
        class QuietHandler(SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(webroot)))
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        base = f'http://127.0.0.1:{server.server_port}/bible-study/'
        for relative in ('index.html', '2026-11-06.html', 'sw.js', 'firebase-messaging-sw.js', 'assets/reader.txt', 'icons/reader.txt'):
            with urlopen(base + relative) as response:
                self.assertEqual(response.status, 200)
        for relative in ('staging/2026-11-07.html', 'tools/generate_sitemap.py', 'scripts/send-notification.js', 'README.md'):
            with self.assertRaises(HTTPError) as failure:
                urlopen(base + relative)
            self.assertEqual(failure.exception.code, 404)

    def test_commit_stages_only_intentional_paths(self):
        paths = ['2026-11-06.html', '2026-11-07.html', 'staging/2026-11-07.html',
                 'studies.json', 'search-index.json', 'sitemap.xml']
        paths_file = Path(self.temporary.name) / 'paths.json'
        paths_file.write_text(json.dumps(paths))
        with patch('release.run', side_effect=['', None, '2026-11-07.html\n', None, None]) as execute:
            commit_release(self.root, '2026-11-07', paths_file)
        self.assertEqual(execute.call_args_list[1].args[0], ['git', 'add', '--', *paths])
        self.assertEqual(execute.call_args_list[-1].args[0], ['git', 'push', 'origin', 'HEAD:main'])
        self.assertTrue(all('-A' not in call.args[0] for call in execute.call_args_list))

    def test_commit_rejects_unrelated_or_pre_staged_paths(self):
        paths_file = Path(self.temporary.name) / 'paths.json'
        paths_file.write_text('["README.md"]')
        with self.assertRaises(ValueError):
            commit_release(self.root, '2026-11-07', paths_file)
        paths_file.write_text('["2026-11-07.html"]')
        with patch('release.run', return_value='README.md\n'), self.assertRaises(ValueError):
            commit_release(self.root, '2026-11-07', paths_file)

    def test_actual_client_dependency_closure_and_archive_api(self):
        output = Path(self.temporary.name) / 'actual-site'
        build_site(SOURCE, output)
        # Static reader dependencies in HTML, CSS and service workers must survive.
        references = set()
        for source in list(SOURCE.glob('*.html')) + list((SOURCE / 'assets').glob('*.css')) + [SOURCE / 'sw.js', SOURCE / 'firebase-messaging-sw.js']:
            text = source.read_text(encoding='utf-8')
            references.update(re.findall(r'(?:/bible-study/)?((?:assets|icons)/[A-Za-z0-9_.\-/]+)', text))
            references.update(value.removeprefix('/bible-study/') for value in re.findall(r"['\"](/bible-study/[^'\"]+\.(?:html|json|js))['\"]", text))
        for icon in json.loads((SOURCE / 'manifest.json').read_text())['icons']:
            references.add(icon['src'])
        for reference in references:
            self.assertTrue((output / reference).is_file(), reference)
        self.assertGreater(len(references), 25)
        manifest = json.loads((SOURCE / 'asset-manifest-v5_1_0.json').read_text())
        for asset in manifest['assets']:
            self.assertTrue((output / asset).is_file())
        archive = (SOURCE / 'assets/archive-search-6fcac06e.js').read_text()
        self.assertIn('api.github.com', archive)
        self.assertIn('raw.githubusercontent.com', archive)
        self.assertNotIn('asset-manifest-v5_1_0.json', (SOURCE / 'sw.js').read_text())


if __name__ == '__main__':
    unittest.main()
