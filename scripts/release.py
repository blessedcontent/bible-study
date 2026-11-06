#!/usr/bin/env python3
"""Prepare a release, an isolated dry run, or its explicitly scoped commit."""
from __future__ import annotations

import argparse
from datetime import date, timedelta
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

STUDY = re.compile(r'^\d{4}-\d{2}-\d{2}\.html$')
PUBLIC_FILES = (
    'index.html', 'about.html', 'corrections.html', 'privacy.html',
    'scripture-sources.html', 'manifest.json', 'sw.js', 'firebase-messaging-sw.js',
    'robots.txt', 'sitemap.xml', 'studies.json', 'search-index.json', '.nojekyll',
)
PUBLIC_DIRECTORIES = ('assets', 'icons')
EXCLUDED_PARTS = {'.git', '.github', '__pycache__', 'staging', 'tools', 'scripts'}


def run(args, root, *, capture=False):
    return subprocess.run(args, cwd=root, check=True, text=True, encoding='utf-8',
                          stdout=subprocess.PIPE if capture else None).stdout


def context(root, now=None):
    command = ['node', str(root / 'scripts/live-study.js'), 'dates']
    if now:
        command.append(now)
    return json.loads(run(command, root, capture=True))


def live_check(root, target):
    return json.loads(run(['node', str(root / 'scripts/live-study.js'), 'probe',
                           target, str(root)], root, capture=True))


def promotion(root, target):
    date.fromisoformat(target)
    published, staged = root / f'{target}.html', root / 'staging' / f'{target}.html'
    if published.is_file():
        print(f'{target}.html is already committed; still checking the live URL.')
        return False
    if not staged.is_file():
        raise ValueError(f'Due study staging/{target}.html is missing')
    shutil.copyfile(staged, published)
    staged.unlink()
    print(f'Promoted staging/{target}.html')
    return True


def runway(root, target):
    next_date = date.fromisoformat(target)
    while (root / f'{next_date}.html').is_file():
        next_date += timedelta(days=1)
    start = next_date
    count = 0
    while (root / 'staging' / f'{next_date}.html').is_file():
        count += 1
        next_date += timedelta(days=1)
    return {'start': str(start), 'consecutive_days': count, 'first_missing': str(next_date)}


def report_runway(value):
    message = (f"Staging runway: {value['consecutive_days']} consecutive day(s) "
               f"from {value['start']}; first missing date: {value['first_missing']}.")
    print(message)
    if value['consecutive_days'] < 3:
        print(f'::warning::Staging runway is below three completed days. {message}')


def deploy_needed(event, promoted, live):
    # Recompute from HTTP on every run, including after a committed promotion.
    return event == 'push' or promoted or not live


def public_file(relative):
    parts = relative.parts
    if any(part in EXCLUDED_PARTS for part in parts):
        return False
    if any(part.startswith('.') for part in parts) and relative.as_posix() != '.nojekyll':
        return False
    return (len(parts) == 1 and (relative.name in PUBLIC_FILES or STUDY.fullmatch(relative.name))) or (
        len(parts) > 1 and parts[0] in PUBLIC_DIRECTORIES)


def build_site(root, destination):
    root, destination = root.resolve(), destination.resolve()
    if destination == root or destination.exists():
        raise ValueError('Site build destination must be a fresh directory outside the source files')
    selected = [root / name for name in PUBLIC_FILES]
    selected += sorted(p for p in root.iterdir() if STUDY.fullmatch(p.name))
    for directory in PUBLIC_DIRECTORIES:
        source = root / directory
        if source.is_symlink() or not source.is_dir():
            raise ValueError(f'Missing or linked public directory: {directory}')
        selected.extend(p for p in source.rglob('*') if not p.is_dir())
        if any(p.is_symlink() for p in source.rglob('*')):
            raise ValueError(f'Linked file or directory in {directory}')
    approved = []
    for source in selected:
        relative = source.relative_to(root)
        if not public_file(relative):
            continue
        if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to(root):
            raise ValueError(f'Missing or linked public file: {relative}')
        approved.append((source, relative))
    destination.mkdir(parents=True)
    for source, relative in approved:
        output = destination / relative
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, output)
    print(f'Built reader-only site: {len(approved)} files; excluded staging, tools, scripts and repository metadata.')
    return len(approved)


def refresh(root, paths_file):
    run([sys.executable, 'tools/refresh-site-data.py', '--root', '.',
         '--changed-out', str(paths_file)], root)
    for script, output in (('generate_studies_json.py', 'studies.json'),
                           ('generate_search_index.py', 'search-index.json'),
                           ('generate_sitemap.py', 'sitemap.xml')):
        args = [sys.executable, f'tools/{script}', '--root', '.', '--out', output]
        run(args, root)
        run(args + ['--check'], root)
    return json.loads(paths_file.read_text(encoding='utf-8'))


def prepare_working(root, event, dates, probe, state_dir):
    target = dates['target']
    promoted = promotion(root, target) if event != 'push' else False
    changed = refresh(root, state_dir / 'navigation-paths.json') if promoted else []
    allowed = [f'{target}.html', f'staging/{target}.html',
               'studies.json', 'search-index.json', 'sitemap.xml'] + changed if promoted else []
    allowed = sorted(set(allowed))
    (state_dir / 'release-paths.json').write_text(json.dumps(allowed) + '\n', encoding='utf-8')
    coverage = runway(root, target)
    report_runway(coverage)
    live = probe(root, target)
    print(f"Live check {live['url']}: {live['reason']}")
    # Also recover today's page if the 15:00 cutoff has advanced the due date.
    today = None
    if dates['today'] != target and (root / f"{dates['today']}.html").is_file():
        today = probe(root, dates['today'])
        print(f"Live check {today['url']}: {today['reason']}")
    needed = deploy_needed(event, promoted, live['live']) or (today is not None and not today['live'])
    count = build_site(root, root / '_site')
    return {'target': target, 'promoted': promoted, 'would_deploy': needed,
            'live': live, 'today_live': today, 'runway': coverage, 'site_files': count,
            'commit_paths': allowed}


def prepare(root, event, dry_run=False, now=None, probe=live_check):
    dates = context(root, now)
    state_path = Path(os.environ.get('RUNNER_TEMP', tempfile.gettempdir()))
    with tempfile.TemporaryDirectory(prefix='bible-study-release-', dir=state_path) as temporary:
        state = Path(temporary)
        if dry_run:
            working = state / 'checkout'
            shutil.copytree(root, working, ignore=shutil.ignore_patterns('.git', '_site', '__pycache__'))
            result = prepare_working(working, event, dates, probe, state)
        else:
            result = prepare_working(root, event, dates, probe, state)
            if result['promoted']:
                # Keep exact intentional paths outside the deployed source tree.
                paths_file = state_path / 'bible-study-release-paths.json'
                shutil.copyfile(state / 'release-paths.json', paths_file)
                result['paths_file'] = str(paths_file)
    result['dry_run'] = dry_run
    result['deploy'] = result['would_deploy'] and not dry_run
    if dry_run:
        print('DRY RUN: promotion was isolated; no commit, push, deployment or notifications.')
    return result


def commit_release(root, target, paths_file):
    date.fromisoformat(target)
    paths = json.loads(paths_file.read_text(encoding='utf-8'))
    fixed = {f'staging/{target}.html', 'studies.json', 'search-index.json', 'sitemap.xml'}
    if not paths or any(p not in fixed and not STUDY.fullmatch(p) for p in paths):
        raise ValueError('Unexpected release commit path')
    staged = run(['git', 'diff', '--cached', '--name-only'], root, capture=True).strip()
    if staged:
        raise ValueError('Refusing to include pre-staged changes in a release commit')
    run(['git', 'add', '--', *paths], root)
    if not run(['git', 'diff', '--cached', '--name-only'], root, capture=True).strip():
        print('Nothing to commit')
        return
    run(['git', '-c', 'user.name=github-actions[bot]',
         '-c', 'user.email=github-actions[bot]@users.noreply.github.com',
         'commit', '-m', f'Publish {target} daily study'], root)
    run(['git', 'push', 'origin', 'HEAD:main'], root)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('prepare', 'commit', 'probe', 'runway', 'build'))
    parser.add_argument('--root', type=Path, default=Path('.'))
    parser.add_argument('--event', choices=('push', 'schedule', 'workflow_dispatch', 'pull_request'), default='workflow_dispatch')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--now', help='ISO time for a local dry-run simulation')
    parser.add_argument('--target')
    parser.add_argument('--paths-file', type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    if args.command == 'prepare':
        dry_run = args.dry_run or os.environ.get('RELEASE_DRY_RUN') == 'true'
        if args.now and not dry_run:
            parser.error('--now is only allowed with --dry-run')
        if not dry_run and os.environ.get('GITHUB_REF', 'refs/heads/main') != 'refs/heads/main':
            raise ValueError('Only main may publish. Use dry-run on a review branch.')
        result = prepare(root, args.event, dry_run, args.now)
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
                for key in ('target', 'promoted', 'deploy', 'paths_file'):
                    value = result.get(key, '')
                    output.write(f'{key}={str(value).lower() if isinstance(value, bool) else value}\n')
    elif args.command == 'commit':
        if os.environ.get('RELEASE_DRY_RUN') == 'true' or os.environ.get('GITHUB_REF') != 'refs/heads/main':
            raise ValueError('Commit/push is restricted to a real release on main')
        if not args.target or not args.paths_file:
            parser.error('commit requires --target and --paths-file')
        commit_release(root, args.target, args.paths_file)
        return
    else:
        target = args.target or context(root)['target']
        if args.command == 'probe':
            result = live_check(root, target)
        elif args.command == 'runway':
            result = runway(root, target)
            report_runway(result)
        else:
            result = {'site_files': build_site(root, root / '_site')}
    report = json.dumps(result, indent=2)
    print(report)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as summary:
            summary.write(f'### Release check\n\n```json\n{report}\n```\n')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f'::error::{error}', file=sys.stderr)
        raise SystemExit(1)
