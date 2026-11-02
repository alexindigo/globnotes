"""Pre-push date check (docs/testing.md). Git metadata only; runs no tests.

For every pushed range, each new commit's author and committer dates must be
outside weekdays 09:00-18:00 America/Los_Angeles, and both dates must be
non-decreasing from the remote tip through the range. Reads the pre-push
input (`<local ref> <local oid> <remote ref> <remote oid>` per line) on stdin.
"""
from datetime import datetime, time
import subprocess
import sys
from zoneinfo import ZoneInfo

ZONE = ZoneInfo('America/Los_Angeles')
ZERO = '0' * 40


def git(*args, check=True):
    result = subprocess.run(['git', '--no-optional-locks', *args], capture_output=True, text=True, check=False)
    if check and result.returncode:
        raise RuntimeError(f'git {" ".join(args)}: {result.stderr.strip()}')
    return result


def quiet(value):
    return value.weekday() < 5 and time(9) <= value.time() < time(18)


def dates(commit):
    fields = git('show', '-s', '--format=%aI%x00%cI', commit).stdout.strip().split('\0')
    return tuple(datetime.fromisoformat(value).astimezone(ZONE) for value in fields)


def check_range(base, commits):
    """`base` is already published: it bounds the order but is not checked itself."""
    problems = []
    previous = dates(base) if base else None
    for commit in commits:
        current = dates(commit)
        for label, value in zip(('author', 'committer'), current):
            if quiet(value):
                problems.append(f'{commit[:12]}: {label} date {value.isoformat()} is inside weekday 09:00-18:00 Pacific')
        if previous:
            for label, value, before in zip(('author', 'committer'), current, previous):
                if value < before:
                    problems.append(f'{commit[:12]}: {label} date {value.isoformat()} is before its predecessor\'s {before.isoformat()}')
        previous = current
    return problems


def incoming(remote, local, remote_oid):
    """The commits this ref update publishes, oldest first, and their published base."""
    if remote_oid != ZERO:
        if git('cat-file', '-e', f'{remote_oid}^{{commit}}', check=False).returncode:
            raise RuntimeError(f'remote tip {remote_oid[:12]} is not in this repository; fetch first')
        if git('merge-base', '--is-ancestor', remote_oid, local, check=False).returncode:
            raise RuntimeError(f'{local[:12]} does not contain the remote tip {remote_oid[:12]}')
        return remote_oid, git('rev-list', '--reverse', f'{remote_oid}..{local}').stdout.split()
    # A new ref: everything not yet on any of this remote's branches.
    if not git('for-each-ref', '--count=1', f'refs/remotes/{remote}/').stdout.strip():
        raise RuntimeError(f'no remote-tracking branches for {remote!r}; fetch it first')
    commits = git('rev-list', '--reverse', local, '--not', f'--remotes={remote}').stdout.split()
    base = None
    if commits:
        parent = git('rev-parse', '--verify', '--quiet', f'{commits[0]}^', check=False).stdout.strip()
        base = parent or None
    return base, commits


def main(argv):
    remote = argv[1] if len(argv) > 1 else 'origin'
    problems = []
    for line in sys.stdin:
        if not line.strip():
            continue
        local_ref, local, remote_ref, remote_oid = line.split()
        if local == ZERO:
            continue  # deletion: nothing is published
        try:
            base, commits = incoming(remote, local, remote_oid)
        except RuntimeError as error:
            problems.append(f'{remote_ref}: {error}')
            continue
        problems += [f'{remote_ref}: {problem}' for problem in check_range(base, commits)]
    for problem in problems:
        print(f'pre-push: {problem}', file=sys.stderr)
    if problems:
        print('pre-push: rejected; commit dates must be outside the quiet hours and in order', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
