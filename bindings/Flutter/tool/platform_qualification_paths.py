#!/usr/bin/env python3
"""Choose fork qualification targets conservatively from an exact head delta.

Unknown paths, incomplete comparisons and rebases run both targets. Platform-only
changes can keep the other target's already running, identical-input job useful.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess


MAC_TOOLS = {
    'bindings/Flutter/tool/check_macos_metal_sdk.py',
    'bindings/Flutter/tool/find_macos_framework.py',
    'bindings/Flutter/tool/build_macos_probe.py',
    'bindings/Flutter/tool/qualify_macos_texture.py',
    'bindings/Flutter/tool/qualify_macos_view.py',
}
WINDOWS_TOOLS = {'bindings/Flutter/tool/check_windows_desktop_sdk.py'}


def impact(files):
    if not isinstance(files, list) or len(files) >= 300:
        return {'windows', 'macos'}
    targets = set()
    for entry in files:
        if not isinstance(entry, dict) or not isinstance(entry.get('filename'), str):
            return {'windows', 'macos'}
        paths = [entry['filename']]
        if entry.get('status') == 'renamed':
            if not isinstance(entry.get('previous_filename'), str):
                return {'windows', 'macos'}
            paths.append(entry['previous_filename'])
        for path in paths:
            if path.startswith('bindings/Flutter/macos/') or path in MAC_TOOLS:
                targets.add('macos')
            elif path.startswith('bindings/Flutter/windows/') or path in WINDOWS_TOOLS:
                targets.add('windows')
            elif path.startswith('bindings/Flutter/linux/'):
                continue
            else:
                targets.update(('windows', 'macos'))
    return targets


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--before', default='')
    parser.add_argument('--head', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repository):
        parser.error('expected an owner/repository name')
    if not re.fullmatch(r'[0-9a-f]{40}', args.head):
        parser.error('expected a pinned head SHA')
    targets, reason = {'windows', 'macos'}, 'initial-or-unavailable-comparison'
    changed = None
    if re.fullmatch(r'[0-9a-f]{40}', args.before):
        result = subprocess.run(['gh', 'api', f'repos/{args.repository}/compare/{args.before}...{args.head}'],
                                capture_output=True, text=True, timeout=60)
        if result.returncode == 0:
            comparison = json.loads(result.stdout)
            if comparison.get('status') in ('ahead', 'identical') and isinstance(comparison.get('files'), list):
                changed = comparison['files']
                targets, reason = impact(changed), 'exact-linear-head-delta'
    report = {'before': args.before, 'head': args.head, 'reason': reason,
              'windows': 'windows' in targets, 'macos': 'macos' in targets,
              'files': [item.get('filename') for item in changed] if changed is not None else None}
    print(json.dumps(report, indent=2))
    if os.environ.get('GITHUB_OUTPUT'):
        with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
            for platform in ('windows', 'macos'):
                output.write(platform + '=' + str(report[platform]).lower() + '\n')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a') as summary:
            summary.write('Exact source delta: `' + args.before + '` → `' + args.head + '`.\n\n')
            summary.write('```json\n' + json.dumps(report, indent=2) + '\n```\n')


if __name__ == '__main__':
    main()
