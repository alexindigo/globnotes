"""Exercise the pre-push checker with real Git metadata and synthetic stdin."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/check-push-dates.py'
ZERO = '0' * 40


class PushDatesTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='push-dates-')
        self.addCleanup(self.directory.cleanup)
        self.repo = self.directory.name
        self.git('init', '--quiet')
        self.tree = self.git('mktree', stdin='')

    def git(self, *args, stdin=None, env=None):
        return subprocess.run(
            ['git', *args], cwd=self.repo, input=stdin, env=env,
            capture_output=True, text=True, check=True,
        ).stdout.strip()

    def commit(self, author, committer=None, parent=None):
        env = {
            **os.environ,
            'GIT_AUTHOR_NAME': 'Fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.test',
            'GIT_COMMITTER_NAME': 'Fixture', 'GIT_COMMITTER_EMAIL': 'fixture@example.test',
            'GIT_AUTHOR_DATE': author, 'GIT_COMMITTER_DATE': committer or author,
        }
        parents = ['-p', parent] if parent else []
        return self.git('commit-tree', self.tree, *parents, stdin='fixture\n', env=env)

    def check(self, local, base=ZERO):
        result = subprocess.run(
            [sys.executable, '-B', str(SCRIPT), 'origin'], cwd=self.repo,
            input=f'refs/heads/topic {local} refs/heads/topic {base}\n',
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.stdout, '')
        return result.returncode, result.stderr

    def test_rebased_author_can_predate_base_and_previous_commit(self):
        base = self.commit('2026-11-04T18:00:00-08:00')
        first = self.commit('2026-10-29T08:00:00-07:00', '2026-11-04T19:00:00-08:00', base)
        second = self.commit('2026-10-28T08:00:00-07:00', '2026-11-04T20:00:00-08:00', first)
        self.assertEqual(self.check(second, base), (0, ''))

    def test_author_in_quiet_hours_is_rejected(self):
        base = self.commit('2026-11-04T18:00:00-08:00')
        commit = self.commit('2026-10-29T09:19:09-07:00', '2026-11-04T19:00:00-08:00', base)
        code, stderr = self.check(commit, base)
        self.assertEqual(code, 1)
        self.assertIn('author date', stderr)
        self.assertIn('is inside weekday', stderr)
        self.assertNotIn('before its predecessor', stderr)

    def test_committer_before_previous_commit_is_rejected(self):
        base = self.commit('2026-11-04T18:00:00-08:00')
        first = self.commit('2026-11-04T20:00:00-08:00', parent=base)
        second = self.commit('2026-11-04T21:00:00-08:00', '2026-11-04T19:00:00-08:00', first)
        code, stderr = self.check(second, base)
        self.assertEqual(code, 1)
        self.assertIn('committer date', stderr)
        self.assertIn('before its predecessor', stderr)

    def test_committer_before_published_base_is_rejected(self):
        base = self.commit('2026-11-04T20:00:00-08:00')
        commit = self.commit('2026-11-04T21:00:00-08:00', '2026-11-04T19:00:00-08:00', base)
        code, stderr = self.check(commit, base)
        self.assertEqual(code, 1)
        self.assertIn('committer date', stderr)
        self.assertIn("before its predecessor's 2026-11-04T20:00:00-08:00", stderr)

    def test_weekday_boundaries_for_both_dates(self):
        for label in ('author', 'committer'):
            for hour, expected in ((9, 1), (18, 0)):
                with self.subTest(label=label, hour=hour):
                    boundary = f'2026-11-05T{hour:02d}:00:00-08:00'
                    outside = '2026-11-05T18:00:00-08:00'
                    author, committer = (boundary, outside) if label == 'author' else (outside, boundary)
                    commit = self.commit(author, committer)
                    code, stderr = self.check(commit)
                    self.assertEqual(code, expected, stderr)
                    if expected:
                        self.assertIn(f'{label} date', stderr)

    def test_equal_committer_dates_are_accepted(self):
        base = self.commit('2026-11-04T18:00:00-08:00')
        commit = self.commit('2026-10-29T08:00:00-07:00', '2026-11-04T18:00:00-08:00', base)
        self.assertEqual(self.check(commit, base), (0, ''))

    def test_weekend_quiet_hours_are_accepted(self):
        commit = self.commit('2026-11-07T09:00:00-08:00', '2026-11-07T12:00:00-08:00')
        self.assertEqual(self.check(commit), (0, ''))

    def test_annotated_tags_are_peeled(self):
        base = self.commit('2026-11-04T18:00:00-08:00')
        commit = self.commit('2026-10-29T08:00:00-07:00', '2026-11-04T19:00:00-08:00', base)
        for name, target in (('published', base), ('local', commit)):
            self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
                     'tag', '-a', name, target, '-m', name)
        self.assertEqual(self.check(self.git('rev-parse', 'local'), self.git('rev-parse', 'published')), (0, ''))

    def test_first_push_uses_tracking_base(self):
        base = self.commit('2026-11-04T18:00:00-08:00')
        self.git('update-ref', 'refs/remotes/origin/main', base)
        commit = self.commit('2026-10-29T08:00:00-07:00', '2026-11-04T19:00:00-08:00', base)
        self.assertEqual(self.check(commit), (0, ''))
        earlier = self.commit('2026-10-29T08:00:00-07:00', '2026-11-04T08:00:00-08:00', base)
        code, stderr = self.check(earlier)
        self.assertEqual(code, 1)
        self.assertIn('committer date', stderr)
        self.assertIn('before its predecessor', stderr)

    def test_first_push_without_tracking_checks_whole_history(self):
        base = self.commit('2026-11-04T09:00:00-08:00')
        commit = self.commit('2026-11-04T18:00:00-08:00', parent=base)
        code, stderr = self.check(commit)
        self.assertEqual(code, 1)
        self.assertIn(f'{base[:12]}: author date', stderr)

    def test_published_quiet_hours_are_not_rechecked(self):
        base = self.commit('2026-11-04T09:00:00-08:00')
        commit = self.commit('2026-11-04T18:00:00-08:00', parent=base)
        self.assertEqual(self.check(commit, base), (0, ''))

    def test_deletion_skips_missing_remote_object(self):
        self.assertEqual(self.check(ZERO, '1' * 40), (0, ''))


if __name__ == '__main__':
    unittest.main()
