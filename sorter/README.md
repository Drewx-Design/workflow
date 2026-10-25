# Sorter

Built for my own workflow on Windows 11. I'm sharing this as a reference for the ideas and decisions behind it. It isn't designed to be copied directly into another setup; the notes below explain the assumptions you'll need to revisit if you adapt the code.

I use this to keep an issue backlog ordered against the next product milestone. It reads open GitHub issues and repository evidence, asks separate models to assess them, and compiles their answers into a proposed backlog. It records uncertainty and disagreement rather than inventing a ranking.

The sorter can write the native Priority, Horizon, Effort, Lifecycle, and Sort key fields under its versioned policy. It retains evidence, assessments, approvals, attempts, and readbacks so an interrupted run can be reconciled. Changes made by the operator are treated as holds.

## Try the tests

Requirements: Windows 11, Node.js matching `^20.20.0 || >=22.22.0`, and npm. Use Node 22.22+ if installing a newer Node release. The package lock pins the dependencies used by this copy; `.npmrc` selects the legacy peer resolver because npm 11.4.2's default resolver crashes on this dependency graph.

```powershell
cd sorter
npm ci
npm test
npm run typecheck
```

Tests use constructed evidence and mock transports. Private captured assessments and historical journals are not distributed. The examples use fresh state and do not migrate an existing sorter.

## If you adapt the code

The current implementation expects the `scripts/` directory at the root of the repository being managed, local `node_modules`, an HTTPS GitHub origin, and an `origin/main` branch.

1. Copy the runtime files under `scripts/` into your repository, preserving their paths. Add the dependencies and commands from this folder's `package.json` to your own manifest. Do not replace an existing manifest wholesale.
2. Replace `example-org`, `example-repo`, and `example-user` in the runtime files with your GitHub organization, repository, and operator login. Search the scripts for all three placeholders; the origin checks, policy identity, and evidence collector must agree. Keep tests on their example identities.
3. Adapt [the milestone example](examples/milestone-1.md) and commit it as `docs/roadmap/milestone-1.md`. It needs a positive `spec_version`, one `## Rubric` section, and one `## Tier anchors` section. Define up to ten numbered milestone steps. Also supply your own `STRATEGY.md` and `docs/runbooks/github-issue-roadmap.md`; these are evidence inputs, not bundled private project documents.
4. Set up the native issue fields used by `scripts/lib/github-issue-roadmap/stewardship-policy.ts`. The implementation uses GitHub's native issue fields, not similarly named Project columns. A repository without the required field support is not ready for live use.
5. Install and authenticate the required CLIs: Git, GitHub CLI, Claude Code, and Codex. Model adapters retain the original requested models and operating limits. The Codex adapter uses an isolated, pinned app-server installation; see `scripts/github-issue-roadmap-astra-seat-install.ts`. The GLM adapter reads the operator's DPAPI-protected credential from `%USERPROFILE%\.config\glm-opinion\credential.dat` (or `credential-<slot>.dat`).
6. Review the credential paths and environment boundary in `scripts/run-github-issue-roadmap-sort.ps1`. Its GitHub credential is a DPAPI-protected file at `%USERPROFILE%\.codex\roadmap-shadow-activation\roadmap-shadow-publish-token.dpapi`, read only for commands that need it. Create your own credentials outside the repository. No credentials are included here.

Commit the adapted runtime to your repository's `main` before using the wrapper. It verifies that installation against the remote and refuses a different origin or unmerged code.

## Commands

Run the PowerShell wrapper from the target repository after setup:

```powershell
.\scripts\run-github-issue-roadmap-sort.ps1 -Command status
.\scripts\run-github-issue-roadmap-sort.ps1 -Command init
.\scripts\run-github-issue-roadmap-sort.ps1 -Command shadow
```

`init` records the initial state. `shadow` collects and assesses without applying proposed issue-field changes. Model calls can consume your provider allowance. Inspect the snapshot and report before passing its identifier to `-Command approve -Snapshot <identifier>`; `run` is the live mutation path. Approval, adoption, current evidence, and readback checks still apply.

Other commands include `preview`, `rehearse`, `pause`, `resume`, `pin`, `release`, `policy-update`, and `lifecycle-receipts`. Argument validation lives in `scripts/github-issue-roadmap-sort.ts`.

The optional Task Scheduler installer prints XML by default and registers a **disabled** task only with `-RegisterDisabled`. Its current schedule requires Windows' Eastern time zone and uses GLM slot `secondary`; adapt those settings deliberately for your machine. It does not silently activate the sorter.

## Layout

- `scripts/github-issue-roadmap-sort.ts`: command orchestration.
- `scripts/lib/github-issue-roadmap/stewardship-*`: evidence, model adapters, ranking, state, and execution.
- `scripts/run-stewardship-seat-job.ps1`: Windows process containment for model calls.
- `scripts/__tests__/`: synthetic regression tests.

Intake and sorter carry copies of their shared roadmap modules so each folder can be tested independently. If adopting both, keep one reviewed set of shared files in the target repository.

Bundled intake stack descriptors retain opaque rubric and toolchain compatibility identifiers, not verified build attestations for this export. Their prompt hashes match the included prompt and their release is `workflow-export-unqualified`; establish your own reviewed provenance before deployment.
