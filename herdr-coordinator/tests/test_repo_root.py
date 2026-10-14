from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import hashlib
import os
import subprocess
import tempfile
import unittest
from unittest import mock

import repo_root


class RepoFixture(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.base = self.root / "state"
        environment = mock.patch.dict(os.environ, {"HERDR_COORD_BASE": str(self.base)})
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop("HERDR_COORD_HOME", None)

    def git(self, repo, *args):
        return subprocess.run(
            ["git", "-C", str(repo), *args], check=True, capture_output=True,
            text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout.strip()

    def make_repo(self, relative):
        repo = self.root / relative
        repo.mkdir(parents=True)
        self.git(repo, "init", "--quiet")
        return repo

    def make_worktree(self, repo):
        self.git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture")
        worktree = repo.with_name(repo.name + "-worktree")
        self.git(repo, "worktree", "add", "--detach", str(worktree))
        return worktree


class RepoRootTests(RepoFixture):
    def test_resolves_nested_directory_and_file_to_main_checkout(self):
        repo = self.make_repo("Main Répo")
        nested = repo / "one" / "two"
        nested.mkdir(parents=True)
        file = nested / "file.txt"
        file.write_text("fixture", encoding="utf-8")
        for path in (repo, nested, file):
            with self.subTest(path=path):
                self.assertEqual(repo_root.resolve_repo(path), repo)

    def test_sibling_worktree_resolves_to_main_checkout(self):
        repo = self.make_repo("main")
        worktree = self.make_worktree(repo)
        nested = worktree / "nested"
        nested.mkdir()
        self.assertEqual(repo_root.resolve_repo(nested), repo)

    def test_not_a_repository_and_missing_directory_are_clear_errors(self):
        for path in (self.root, self.root / "missing"):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "--repo"):
                repo_root.resolve_repo(path)

    def test_git_unavailable_or_timed_out_is_a_clear_error(self):
        for error in (FileNotFoundError("git missing"), subprocess.TimeoutExpired("git", 15)):
            with self.subTest(error=error), mock.patch.object(repo_root.subprocess, "run", side_effect=error):
                with self.assertRaisesRegex(ValueError, "Cannot resolve repository.*--repo"):
                    repo_root.resolve_repo(self.root)

    def test_display_name_slug_and_exact_root_formula(self):
        repo = self.root / "My Repo___--2026!"
        self.assertEqual(repo_root.display_name(repo), "My Repo___--2026!")
        self.assertEqual(repo_root.slug(repo), "my-repo-2026")
        expected_hash = hashlib.sha256(repo_root.normalize(repo).encode("utf-8")).hexdigest()[:8]
        self.assertEqual(repo_root.state_root(repo), self.base / "repos" / f"my-repo-2026-{expected_hash}")
        self.assertEqual(repo_root.slug(self.root / "!!!"), "")

    def test_same_folder_name_in_different_parents_gets_different_roots(self):
        first = self.make_repo("one/repo")
        second = self.make_repo("two/repo")
        self.assertNotEqual(repo_root.state_root(first), repo_root.state_root(second))

    @unittest.skipUnless(os.name == "nt", "Windows paths are case insensitive")
    def test_different_letter_case_resolves_to_one_root(self):
        repo = self.make_repo("MixedCase")
        upper = repo_root.resolve_repo(str(repo).upper())
        lower = repo_root.resolve_repo(str(repo).lower())
        self.assertEqual(repo_root.normalize(upper), repo_root.normalize(lower))
        self.assertEqual(repo_root.state_root(upper), repo_root.state_root(lower))

    def test_normalize_resolves_aliases_before_normalizing_case(self):
        canonical = str(self.root / "Main Checkout")
        with mock.patch.object(repo_root.os.path, "realpath", return_value=canonical) as realpath:
            self.assertEqual(repo_root.normalize("alias"), os.path.normcase(canonical))
            realpath.assert_called_once_with("alias")

    @unittest.skipUnless(os.name == "nt", "Windows short paths")
    def test_windows_short_path_has_the_same_root(self):
        import ctypes
        repo = self.make_repo("Long Repository Folder Name")
        buffer = ctypes.create_unicode_buffer(32768)
        length = ctypes.windll.kernel32.GetShortPathNameW(str(repo), buffer, len(buffer))
        self.assertGreater(length, 0)
        self.assertEqual(repo_root.normalize(buffer.value), repo_root.normalize(repo))
        self.assertEqual(repo_root.state_root(buffer.value), repo_root.state_root(repo))

    def test_explicit_base_overrides_environment_and_default_is_localappdata(self):
        repo = self.root / "repo"
        explicit = self.root / "explicit"
        self.assertEqual(repo_root.state_root(repo, explicit).parent, explicit / "repos")
        with mock.patch.dict(os.environ, {"LOCALAPPDATA": str(self.root / "local")}):
            os.environ.pop("HERDR_COORD_BASE")
            self.assertEqual(repo_root.state_root(repo).parent,
                             self.root / "local" / "herdr-coordinator" / "repos")
        self.assertFalse(self.base.exists())


if __name__ == "__main__":
    unittest.main()
