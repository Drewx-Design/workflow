# Adapting ai-intake

[Back to the tool overview](README.md). These are the assumptions and commands for adapting my Windows setup.

## Try the tests

Use Windows 11 and Node.js matching `^20.20.0 || >=22.22.0`.

```powershell
cd ai-intake
npm ci
npm test
npm run typecheck
```

Dependencies are pinned. `.npmrc` works around npm 11.4.2's peer-resolution crash. Private census captures, historical execution rows, calibration data, and tests requiring those records are excluded. Included tests construct their own evidence and disposable repositories.

## If you adapt the code

The runtime expects `scripts/` at the target repository's root and reads committed source evidence from `origin/main`.

1. Copy the runtime files under `scripts/`, preserving paths. Merge the dependencies and the `roadmap:*` commands from this folder's `package.json` into your repository's manifest.
2. Replace the `example-org`, `example-repo`, and `example-user` runtime placeholders. Keep the test fixtures on their example identities. Review `github-issue-roadmap-producers.json`: it defines which artifact types can produce candidates, their locations, and their size limits.
3. Review the assessment prompt, schema, and stack descriptors. The exported descriptors are marked `workflow-export-unqualified`; the original project's calibration is not an approval for your project. If you edit the prompt, update its SHA-256 in both stack descriptors. Do not enable capabilities or remove evidence checks to make a held candidate pass.
4. Install Git, GitHub CLI, Codex, and any model CLI required by the assessment adapters. Set up your own authentication. The filing wrapper accepts `-CredentialPath` for an operator-owned DPAPI-protected GitHub credential; credentials and runtime state belong outside source control.
5. Supply your own `STRATEGY.md` and `docs/runbooks/github-issue-roadmap.md`, and commit both on the target repository's `main`. Census capture requires both as source evidence. Private project documents are not included here. Commit the runtime and candidate source artifacts as well. GitHub issue types and fields must match the transport's schema; the transport uses native issue fields, not Project columns.

The sample automatic capability manifest is disabled. Explicit operator filing is a separate path; the presence of a manifest or a successful dry run does not grant write authority.

The stack descriptors retain the original opaque rubric and toolchain compatibility identifiers. They are not a verified build attestation for this export. The prompt hash is rebound to the included prompt, and `workflow-export-unqualified` gives this copy a distinct stack identity. Establish your own reviewed provenance and qualification before treating the descriptors as evidence of a calibrated deployment.

## Candidate to issue

Start with the constructed candidate examples under `scripts/__tests__/fixtures/github-issue-roadmap/outcome-candidates/`. They illustrate the schema; replace the source identities, evidence hashes, and outcomes with actual repository evidence before filing.

```powershell
# Validate and canonicalize a draft candidate file.
npm run roadmap:candidate -- --in=<draft.json> --out=<candidate.roadmap-outcomes.json>

# Inspect the filing path without authorizing writes.
.\scripts\run-github-issue-roadmap-file-finding.ps1 -Candidate <committed-sidecar-path> -Repository owner/repo

# Explicitly authorize the prepared filing operation after reviewing its result.
.\scripts\run-github-issue-roadmap-file-finding.ps1 -Candidate <committed-sidecar-path> -Repository owner/repo -Execute
```

The sidecar lives under `artifacts/github-issue-roadmap/`, with the source locator percent-encoded in its filename. Read `github-issue-roadmap-producers.json` for the naming rule. Candidates are bounded to five per envelope, with source and revision bindings. A plausible duplicate or insufficient evidence can produce a hold; the result names the next step.

The lower-level `intake-*` commands expose assessment, approval, application, holds, resolution, and draining. They share an execution journal and claims so concurrent workers cannot independently consume the same authority. Start with the filing wrapper rather than assembling those stages by hand.

## Layout

- `scripts/github-issue-roadmap-file-finding.ts`: filing orchestration.
- `scripts/lib/github-issue-roadmap/intake-*`: decisions, approval, evidence, execution journal, and recovery.
- `scripts/lib/github-issue-roadmap/github-intake-approval-transport.ts`: GitHub writes and verification.
- `scripts/github-issue-roadmap-assessment-*`: model prompt and schema.
- `scripts/__tests__/`: constructed fixtures and regression tests.

Intake and sorter share roadmap modules. If adopting both, merge one reviewed set into the target repository. Never overwrite an existing operational journal with an example or test record.
