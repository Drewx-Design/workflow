# Grantsville funder check: the skip rule

This folder is a read-only excerpt of product code from [Grantsville](https://grantsville.co/), a grant-application tool for small nonprofits. The Grantsville codebase is private. These files were copied on 2026-11-16 from its source commit `ebf1244c7ee067b8842b06c7e9f06691f68ecc84`, and `export-manifest.json` records that commit and a hash of every file here.

Before drafting anything, Grantsville checks how a funder accepts applications. That check can recommend not applying. This excerpt is the part that decides when it does.

## When it recommends skipping

`buildQualificationVerdict` in [`src/route-copy.ts`](src/route-copy.ts) first sets aside government programs, which the check doesn't cover yet: they get "Not covered yet" and never a skip recommendation. For every other funder it returns `recommendSkip: true` in three cases, and in no others:

| Case | Where the code decides it | Test |
| --- | --- | --- |
| The funder's quoted route is invitation-only or closed to unsolicited requests. | `classifyStopFact` in [`src/stop-facts.ts`](src/stop-facts.ts) | `lets a quoted don't-proceed fact outrank missing facts` |
| The funder's quoted policy excludes fiscally sponsored applicants, and the organization uses a fiscal sponsor. | `classifyStopFact` in [`src/stop-facts.ts`](src/stop-facts.ts) | `recommends skipping a quoted exclusion when the organization uses a fiscal sponsor` in [`src/__tests__/fiscal-sponsor.test.ts`](src/__tests__/fiscal-sponsor.test.ts) |
| The funder's quoted route is RFP-only, and there is no quoted window, or the first quoted window's text doesn't say open, active, or accepting. | `hasActiveRfp` and `buildQualificationVerdict` in [`src/route-copy.ts`](src/route-copy.ts) | `treats RFP-only as closed until a quoted active window is found` |

"Quoted" means the fact carries a quote, a source URL, and a value that isn't missing or `unknown`. Where a case reads the first quoted route or window, it means the first such fact; facts that fail this test are skipped. An unquoted restriction never produces a skip.

`answerRequiresOverride` and `isStopFactSatisfied` in [`src/stop-facts.ts`](src/stop-facts.ts) classify which saved answers count as overriding a published restriction.

## Run the tests

The tests are in [`src/__tests__/`](src/__tests__/) and run without the private codebase:

```bash
npm ci
npm test
```

## What changed from the source

The two modules and the test are copied as they are, with these exceptions:

- `src/route-copy.ts` lines 1-3: imports now point at `./types` and `./stop-facts` instead of the private codebase's module paths.
- `src/stop-facts.ts` lines 11, 26 and 35: three comments that cited private planning documents by ID now say what those documents decided.

`src/types.ts`, `src/__tests__/fiscal-sponsor.test.ts`, `package.json`, `package-lock.json`, `vitest.config.ts` and `export-manifest.json` were written for this excerpt. `src/types.ts` declares only the type fields the two modules read.
