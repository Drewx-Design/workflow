# Worktree cleanup

Built for my own workflow on Windows 11. I'm sharing this as a reference for the ideas and decisions behind it. It isn't designed to be copied directly into another setup; the notes below explain the assumptions you'll need to revisit if you adapt the code.

Parallel agent work leaves behind branches, linked worktrees, and unfinished files. I use this tool to inspect that work before deciding what can be removed.

It checks repository identity, Git state, process and session activity, worktree leases, links, and recovery evidence. Dirty work can be preserved through a rescue PR or a verified scratch snapshot. Unknown state is held for inspection. Removal rechecks its evidence immediately before acting.

## Requirements and tests

The runtime uses Node.js built-ins, Git, GitHub CLI, and Windows PowerShell. Windows 11 is the supported environment; process inspection, junction handling, notifications, and Task Scheduler are Windows-specific. Use Node.js matching `^20.20.0 || >=22.22.0`.

```powershell
cd worktree-cleanup
npm ci
npm test
```

The dependency installation is for the tests; the cleanup runtime needs no npm packages. Tests use disposable repositories and synthetic session records. `.npmrc` selects the peer resolver used to install the pinned test dependencies.

## If you adapt the code

Copy `scripts/` into the primary checkout you want to manage, preserving paths. Replace `example-org/example-repo` in the runtime with its exact GitHub identity. Review the archive and report locations, rescue and scratch classifications, and activity readers before adoption. The primary checkout must have an HTTPS `origin` and an `origin/main` branch.

Commit the adapted scripts on `main`. The scheduled launcher uses a separate runner pinned to that revision. It refuses an unregistered, redirected, or dirty runner. It also requires the original workflow's activity evidence (including supported agent session records and leases); missing evidence can hold a tree rather than make it removable.

## Preview first

From the target repository:

```powershell
node scripts/worktree-cleanup.mjs inventory --repo C:/Projects/my-repo
node scripts/worktree-cleanup.mjs run --dry-run --repo C:/Projects/my-repo --report-root C:/Temp/cleanup-preview
```

A dry run writes a diagnostic report. It does not fetch, push, create PRs, remove worktrees, persist idle observations, write archives, or prune. Keep the report root outside any worktree eligible for removal.

For a reviewed live run, pass `--manual` instead of `--dry-run`. Live execution can publish rescue commits and PRs and remove eligible worktrees. Existing authentication is used; no credentials are bundled here.

## Optional scheduling

```powershell
# Print the proposed task without installing it.
.\scripts\install-worktree-cleanup.ps1 -Repository C:\Projects\my-repo -PrintXml

# Copy the launcher without registering a task.
.\scripts\install-worktree-cleanup.ps1 -Repository C:\Projects\my-repo -InstallOnly
```

Running the installer without either preview switch registers an **enabled** daily 03:00 task. The owner must be logged in; a locked session works. The default report and install root is `%LOCALAPPDATA%\WorkflowTools\worktree-cleanup`. The supplied installer uses one fixed task name. To schedule multiple repositories, adapt that name and use a distinct `-InstallRoot` for each; changing the install root alone is insufficient.

The launcher is hash-pinned to its installation record. Update it by reinstalling reviewed code. Do not edit its installed hash or journal to clear a hold.

## Recovery

Reports name each worktree's proposed action, result, hold reason, and recovery information. Preserve the journals with the archives. A verified snapshot includes its recovery command; use that exact command and a new destination. `restore` restores a local archive, while `recover` retrieves a published scratch snapshot. Scratch snapshots require the separate `commission --preview` / `commission --confirm` flow before use.

The archive policy retains verified archives for up to 180 days or 10 GB, pruning oldest first. Current-run archives are protected. Review these defaults for your own work.

## Layout

- `scripts/worktree-cleanup.mjs`: CLI and orchestration.
- `scripts/lib/worktree-cleanup/`: inventory, activity, policy, archives, rescue, snapshots, and removal.
- `scripts/install-worktree-cleanup.ps1`: optional scheduled-task installation.
- `scripts/release-worktree.ps1`: explicit owner release.
- `scripts/__tests__/`: disposable-repository regression tests.
