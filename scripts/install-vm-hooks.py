"""Install worktree-local VM hooks. Git metadata only; no host project workloads."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', type=Path, required=True)
    parser.add_argument('--deno', required=True, help='Absolute executable path inside the guest')
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    def git(*argv, cwd=root, allow=(0,)):
        result = subprocess.run(['git', '--no-optional-locks', '-C', str(cwd), *argv], capture_output=True, check=False)
        if result.returncode not in allow:
            raise RuntimeError(result.stderr.decode())
        return result.stdout.decode().strip()
    assert git('branch', '--show-current') == 'v2', 'Install in the existing v2 worktree'
    assert args.profile.is_file() and args.evidence.is_dir()
    assert Path(args.deno).is_absolute()
    hooks = root / '.githooks'
    assert all((hooks / name).is_file() for name in ('pre-commit', 'pre-push'))
    common = Path(git('rev-parse', '--git-common-dir')).resolve()
    assert not git('config', '--get', 'core.hooksPath', allow=(0, 1)), 'Existing hook configuration requires review'
    assert git('config', '--get', 'core.bare', allow=(0, 1)) in ('', 'false')
    assert not git('config', '--get', 'core.worktree', allow=(0, 1))
    assert all(path.name.endswith('.sample') for path in (common / 'hooks').iterdir()), 'Active common hooks require review'
    roots = [Path(line[9:]) for line in git('worktree', 'list', '--porcelain').splitlines() if line.startswith('worktree ')]
    def state(path):
        return {'head': git('rev-parse', 'HEAD', cwd=path),
                'bare': git('rev-parse', '--is-bare-repository', cwd=path),
                'hooks': git('config', '--get', 'core.hooksPath', cwd=path, allow=(0, 1)),
                'signing': git('config', '--get-regexp', r'^(user\.|gpg\.|commit.gpgsign|remote.origin\.)', cwd=path),
                'status': git('status', '--porcelain=v1', '--untracked-files=all', cwd=path)}
    before = {str(path): state(path) for path in roots}
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    with (args.evidence / f'config-before-{stamp}.bak').open('xb') as stream:
        stream.write((common / 'config').read_bytes())
    config = Path(git('rev-parse', '--git-path', 'config.worktree'))
    if config.exists():
        with (args.evidence / f'worktree-config-before-{stamp}.bak').open('xb') as stream:
            stream.write(config.read_bytes())
    # Shared bare=false is safe in each non-bare worktree; no core.worktree is shared.
    git('config', '--local', 'extensions.worktreeConfig', 'true')
    git('config', '--worktree', 'core.hooksPath', str(hooks))
    git('config', '--worktree', 'globnotes.vmProfile', str(args.profile.resolve()))
    git('config', '--worktree', 'globnotes.vmDeno', args.deno)
    after = {str(path): state(path) for path in roots}
    for path in roots:
        expected = dict(before[str(path)])
        if path == root:
            expected['hooks'] = str(hooks)
        assert after[str(path)] == expected, f'Unrelated worktree state changed: {path}'
    receipt = {'before': before, 'after': after, 'profile': str(args.profile), 'guestDeno': args.deno,
               'worktree': str(root), 'worktreeConfigExtension': True}
    with (args.evidence / f'hook-install-{stamp}.json').open('x') as stream:
        stream.write(json.dumps(receipt, indent=2) + '\n')
    print('VM hooks installed for', root, '; other worktrees preserved')


if __name__ == '__main__':
    main()
