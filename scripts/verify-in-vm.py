"""Git hook host controller: metadata/custody/transport only, never host workloads.

Exports exact index/commit trees and invokes the CI runner inside the identified
owned VM. No application imports, private-key reads, test skips or local fallback.
"""
import argparse
from datetime import datetime, time, timezone
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shlex
import stat
import subprocess
import sys
import tarfile
from zoneinfo import ZoneInfo

DOMAIN = 'arch-niri-globnotes-devbase-globnotes-generic-plugin-system'
UUID = '3c6d1972-c1a1-45fe-b08d-804399a85db4'
MAC = '52:54:00:f4:f3:d3'
ORIGIN = 'git@github.com:alexindigo/globnotes.git'
TRANSFER = Path.home() / 'bin/vm-transfer'
GUEST_BASE = '/home/tester/generic-plugin-system/test-quality-cleanup/hooks'

GUEST_CHECK = '''import hashlib,json,os,stat,sys,tarfile
from pathlib import Path
work=Path(sys.argv[1]); root=work/'source'; expected=json.loads((work/'inputs/manifest.json').read_bytes())
assert os.getuid()==1000
if sys.argv[2]=='extract':
 assert not root.exists(); root.mkdir()
 with tarfile.open(work/'inputs/source.tar') as stream: stream.extractall(root,filter='data')
rows=[]
def visit(directory):
 for path in sorted(directory.iterdir()):
  relative=path.relative_to(root).as_posix()
  if relative in ('node_modules','client/dist','client/.vite'): continue
  info=path.lstat(); row={'path':relative,'mode':stat.S_IMODE(info.st_mode)}
  if stat.S_ISDIR(info.st_mode): row['type']='directory'
  else:
   assert stat.S_ISREG(info.st_mode),relative
   data=path.read_bytes(); row.update(type='file',size=len(data),sha256=hashlib.sha256(data).hexdigest())
  rows.append(row)
  if row['type']=='directory': visit(path)
visit(root)
assert {r['path']:r for r in rows}=={r['path']:r for r in expected},'Source drift'
print(json.dumps({'root':str(root),'entries':len(rows),'sourceEqualsGitTree':True}))
'''


def run(argv, cwd, evidence=None, label=None, allow=(0,)):
    result = subprocess.run(argv, cwd=cwd, capture_output=True, check=False,
                            env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'})
    if evidence:
        for channel in ('stdout', 'stderr'):
            with (evidence / f'{label}.{channel}').open('xb') as stream:
                os.fchmod(stream.fileno(), 0o600)
                stream.write(getattr(result, channel))
        with (evidence / f'{label}.json').open('x') as stream:
            json.dump({'argv': argv, 'exit': result.returncode,
                       'stdoutSha256': hashlib.sha256(result.stdout).hexdigest(),
                       'stderrSha256': hashlib.sha256(result.stderr).hexdigest()}, stream, indent=2)
    if result.returncode not in allow:
        sys.stderr.buffer.write(result.stderr)
        sys.stdout.buffer.write(result.stdout)
        raise RuntimeError(f'Command failed ({result.returncode}): {argv!r}')
    return result


def git(root, *args):
    return run(['git', '--no-optional-locks', '-C', str(root), *args], root).stdout


def export_tree(root, tree, inputs):
    files = []
    dirs = set()
    with tarfile.open(inputs / 'source.tar', 'x') as archive:
        for entry in git(root, 'ls-tree', '-rz', '--full-tree', tree).split(b'\0'):
            if not entry:
                continue
            header, rawpath = entry.split(b'\t', 1)
            mode, kind, oid = header.decode().split()
            path = rawpath.decode()
            assert kind == 'blob' and mode in ('100644', '100755'), 'Unsupported tree entry'
            assert not PurePosixPath(path).is_absolute() and '..' not in PurePosixPath(path).parts
            data = git(root, 'cat-file', 'blob', oid)
            permission = 0o755 if mode == '100755' else 0o644
            files.append({'path': path, 'mode': permission, 'type': 'file', 'size': len(data),
                          'sha256': hashlib.sha256(data).hexdigest()})
            dirs.update(str(parent) for parent in PurePosixPath(path).parents if str(parent) != '.')
            member = tarfile.TarInfo(path); member.mode = permission; member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
        for path in sorted(dirs):
            member = tarfile.TarInfo(path); member.type = tarfile.DIRTYPE; member.mode = 0o755
            archive.addfile(member)
    rows = sorted(files + [{'path': path, 'mode': 0o755, 'type': 'directory'} for path in dirs], key=lambda row: row['path'])
    (inputs / 'manifest.json').write_text(json.dumps(rows, indent=2) + '\n')
    (inputs / 'source-check.py').write_text(GUEST_CHECK)
    (inputs / 'vm-ci-gates.sh').write_bytes(git(root, 'show', f'{tree}:scripts/vm-ci-gates.sh'))
    return rows


def guest_ssh(profile, ip):
    host, guest = profile['host'], profile['guest']
    def options(identity, known, alias):
        return ['-F', '/dev/null', '-i', identity, '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
                '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                '-o', f'UserKnownHostsFile={known}', '-o', f'HostKeyAlias={alias}']
    proxy = ['ssh', *options(host['identity_file'], host['known_hosts'], host['hostname']),
             '-W', '%h:%p', f"{host['user']}@{host['hostname']}"]
    return ['ssh', *options(guest['identity_file'], guest['known_hosts'], DOMAIN),
            '-o', 'ProxyCommand=' + shlex.join(proxy), f"{guest['user']}@{ip}"]


def dates(root, commits):
    previous = None
    for index, commit in enumerate(commits):
        fields = git(root, 'show', '-s', '--format=%aI%x00%cI', commit).decode().strip().split('\0')
        current = tuple(datetime.fromisoformat(value).astimezone(ZoneInfo('America/Los_Angeles')) for value in fields)
        if index:
            assert all(not (value.weekday() < 5 and time(9) <= value.time() < time(18)) for value in current), 'Quiet-hour commit'
        if previous:
            assert all(a >= b for a, b in zip(current, previous)), 'Nonmonotone commit dates'
        previous = current


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('pre-commit', 'pre-push'))
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--remote', default='origin')
    parser.add_argument('--url', default=ORIGIN)
    parser.add_argument('--tip-only', action='store_true')
    args = parser.parse_args(); root = args.root.resolve()
    assert git(root, 'branch', '--show-current') == b'v2\n', 'Expected attached v2'
    assert not git(root, 'ls-files', '--unmerged', '-z'), 'Unmerged index'
    profile_path = git(root, 'config', '--get', 'globnotes.vmProfile').decode().strip()
    deno = git(root, 'config', '--get', 'globnotes.vmDeno').decode().strip()
    profile = json.loads(Path(profile_path).read_bytes())
    assert (profile['guest']['domain'], profile['guest']['uuid'], profile['guest']['mac']) == (DOMAIN, UUID, MAC)
    assert profile['host']['hostname'] == 'ark.home' and profile['guest']['user'] == 'tester'
    assert profile['workspace']['path'] == '/home/tester/generic-plugin-system'
    assert Path(deno).is_absolute()
    if args.mode == 'pre-commit':
        refs = [(None, git(root, 'write-tree').decode().strip())]
    else:
        assert args.remote == 'origin' and args.url == ORIGIN
        assert git(root, 'remote', 'get-url', '--push', 'origin').decode().strip() == ORIGIN
        if args.tip_only:
            commits = [git(root, 'rev-parse', 'HEAD').decode().strip()]
        else:
            commits = []
            for line in sys.stdin:
                local_ref, local, remote_ref, remote = line.split()
                assert remote_ref == 'refs/heads/v2' and local != '0' * 40, 'Only v2 updates supported'
                assert local_ref in ('refs/heads/v2', local)
                observed = git(root, 'ls-remote', '--exit-code', '--refs', 'origin', remote_ref).decode().split()[0]
                assert observed == remote, 'Remote changed; recompute publication range'
                run(['git', '-C', str(root), 'merge-base', '--is-ancestor', remote, local], root)
                incoming = git(root, 'rev-list', '--reverse', f'{remote}..{local}').decode().split()
                if incoming:
                    dates(root, [remote, *incoming])
                commits.extend(incoming or [local])
        assert commits, 'No push refs supplied'
        refs = [(commit, git(root, 'rev-parse', commit + '^{tree}').decode().strip()) for commit in dict.fromkeys(commits)]
    for commit, tree in refs:
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        evidence = Path.home() / 'Documents/globnotes/validation' / f'{stamp}-{args.mode}-{tree[:12]}'
        evidence.mkdir(parents=True, mode=0o700); inputs = evidence / 'inputs'; inputs.mkdir()
        rows = export_tree(root, tree, inputs)
        (evidence / 'binding.json').write_text(json.dumps({'root': str(root), 'commit': commit, 'tree': tree,
              'entries': len(rows), 'profile': profile_path, 'guestDeno': deno}, indent=2) + '\n')
        inspect = run([str(TRANSFER), 'inspect', '--profile', profile_path], root, evidence, 'inspect')
        identity = json.loads(inspect.stdout); assert identity['uuid'] == UUID and identity['mac'] == MAC
        ssh = guest_ssh(profile, identity['ip'])
        work = GUEST_BASE + '/' + evidence.name
        create = f'test -d /home/tester/generic-plugin-system && test ! -e {shlex.quote(work)} && mkdir -p {shlex.quote(work + "/inputs")} {shlex.quote(work + "/logs")} {shlex.quote(work + "/artifacts")}'
        run([*ssh, create], root, evidence, 'create')
        transfer = [str(TRANSFER), 'push', '--profile', profile_path]
        run([*transfer, '--dry-run', str(inputs) + '/', work + '/inputs/'], root, evidence, 'preview')
        run([*transfer, '--apply', str(inputs) + '/', work + '/inputs/'], root, evidence, 'transfer')
        run([str(TRANSFER), 'verify', '--profile', profile_path, '--direction', 'push', str(inputs) + '/', work + '/inputs/'], root, evidence, 'checksum')
        command = shlex.join(['env', f'WORK={work}', f'DENO={deno}', f'VALIDATED_VM_UUID={UUID}',
                              'bash', work + '/inputs/vm-ci-gates.sh'])
        result = run([*ssh, command], root, evidence, 'gates', allow=tuple(range(256)))
        guest = evidence / 'guest'; guest.mkdir()
        run([str(TRANSFER), 'pull', '--profile', profile_path, '--apply', '--exclude', 'source', '--exclude', 'inputs',
             work + '/', str(guest) + '/'], root, evidence, 'collect')
        run([str(TRANSFER), 'verify', '--profile', profile_path, '--direction', 'pull', '--exclude', 'source', '--exclude', 'inputs',
             work + '/', str(guest) + '/'], root, evidence, 'collect-checksum')
        print('VM verification evidence:', evidence, flush=True)
        sys.stdout.buffer.write(result.stdout); sys.stdout.buffer.flush()
        sys.stderr.buffer.write(result.stderr); sys.stderr.buffer.flush()
        assert result.returncode == 0, f'VM validation failed: exit{result.returncode}; preserved at {evidence}'
    print('Exact Git source passed VM validation')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'VM validation blocked: {error}', file=sys.stderr)
        sys.exit(1)
