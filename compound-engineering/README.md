# How I use Compound Engineering

[Back to the tools](../README.md).

I use Compound Engineering to move from a product question to a reviewed change. My adaptations divide responsibilities between models, keep implementation within the agreed scope, and carry useful lessons into the next task. I define the product goals and make the decisions that need my judgment.

The underlying method and plugin come from [Compound Engineering, maintained by Kieran Klaassen and Trevin Chow](https://every.to/guides/compound-engineering). This page describes my configuration and working rules as of **November 3, 2026**. The tools elsewhere in this repository support that workflow; the [development notes](#development-notes) distinguish recent work from the published source snapshots.

## From question to working product

**Frame the problem → ground the plan → implement → verify and review → inspect the product → retain useful lessons**

For substantial changes, I settle the intended outcome, constraints, and acceptance examples before implementation. Repository research checks whether the proposed files, interfaces, and sequencing match the code that exists. A reviewer can challenge the premise before the solution is fixed.

Workers receive a bounded deliverable and reading list, and work in isolated checkouts. The host coordinates the units and checks the result. Small changes take a shorter path; a wording fix does not need the review process for a database migration.

## Who handles which decisions

These are my configured roles, rather than a general ranking of models:

| Responsibility | Current assignment | What I ask it to establish |
| --- | --- | --- |
| Brainstorming, substantial plans, orchestration, and synthesis | Claude | Does the proposed work serve the product goal? |
| Repository research, implementation, debugging, and most code review | Codex | Does the approach fit the actual code, and does the change work? |
| Consequential architecture and readiness checks | Codex Astra | Is there a material implementation or release problem? |
| Unresolved design and interaction choices | Claude Fable 5.1 | Which alternative best serves the user, and what evidence could reverse that choice? |
| Premise and risk review | GLM-5.3 | Which assumption, failure case, or alternative has been missed? |
| Experimental scope audit | Kimi K3.1 Pro | Does the implementation add unrequested interface elements or omit planned ones? |

Routine detached Codex workers currently request `gpt-6.1-sol` at `xhigh`; senior checkpoints request `gpt-6-astra`, with `high` for implementation and debugging or `xhigh` for review. These are dated settings. The routine allocation remains provisional while a planned comparison is pending.

If Claude is unavailable, Codex can fill its planning and synthesis roles, with the substitution recorded and a separate GLM review for substantial plans. A second model from the same family is still same-family review.

### Current experiment: Kimi scope review

From October 26 to November 26, I am testing Kimi K3.1 Pro as an advisory fourth model family on roughly ten UI changes implemented without me present. It compares the final changes, after review and fixes, with the agreed plan or issue criteria. It looks for unrequested controls, messages, states, or behaviors, as well as missing required elements.

I track confirmed issues it finds that other reviewers missed, false flags, and the time needed to verify its findings. Each applicable PR records the audit or why it was not run. Two reasoning-effort settings are assigned by a rule fixed in advance. The trial stops early after five counted PRs if there are no confirmed unique catches or false flags exceed catches.

Kimi does not implement changes or replace the required reviews in this trial. Its findings must be checked against the plan and source before they affect a review decision. Results are pending.

## Rules that shape the work

**Choose the smallest adequate solution.** Before dividing a substantial change into implementation units, I ask what it must handle, what can stay with a person, and when it should stop. A new retry, queue, fallback, or safeguard needs a requirement from me or the task, or a concrete failure case. Narrowing the scope or leaving an uncertain case for inspection can be the better response. Reviewers distinguish observed problems from hypothetical ones; tests and verification still apply.

**Settle disagreements with evidence.** Product alignment, implementation readiness, and architectural risk receive separate verdicts. Reviewers see the same frozen plan without each other's conclusions. A source-level finding needs a response grounded in code, tests, traces, or the agreed behavior; agreement between models does not settle it.

**Match review to the change.** Permissions, persistent data, concurrency, external interfaces, and irreversible rollout trigger additional scrutiny. Existing review coverage is reused when the artifact is unchanged. An amendment gets a focused review of the affected portion. If repeated amendments keep introducing new findings, the rule calls for a decision table or executable test to settle the contract.

**Check the version being delivered.** Verification records identify the code revision they checked. A source-only review is labeled as such. Workers cannot edit their way past a passing test result and still treat that earlier result as proof of the final change.

**Keep product scope explicit.** For hands-off UI work, the plan lists the controls, messages, and interaction states it requires. Workers report missing product decisions rather than adding new features on their own. The PR surfaces additions that cannot be traced to the plan so I can resolve them before merge. This scope-control practice was introduced on October 26; its effect is being evaluated.

## An example: narrowing a review role

On October 15, I reviewed how I was using Fable for design advice. The audit supported keeping it for design, interaction, and product-intent choices, while removing its automatic participation in infrastructure, test-policy, and other technical panels.

The reasoning mattered as much as the routing change. Counting how often I accepted an answer could measure agreement with me rather than quality. A separate review challenged that interpretation. The revised evaluation records an initial preference before consultation and calls for a blind assessment of whether the advice adds value.

The resulting rule is specific: use the design reviewer when a consequential design choice remains, and verify the facts supplied to it. Technical review continues through the repository and risk reviewers. This is a sanitized summary of my private October 15 calibration record; it documents a workflow decision, not a benchmark of model superiority.

## Keeping judgment and learning in the loop

My November 3 update puts the learning attempt before the PR opens when the work exposed an incorrect debugging hypothesis or an addition outside the plan. The PR records the saved lesson or the reason there was nothing durable to keep. This keeps the learning close to the work that produced it.

Product inspection at merge is where I can add my own corrections and preferences. Only a preference I actually state can become guidance; approving a PR does not imply that I want every choice in it repeated.

The weekly explanation of recently merged work and the five-UI-PR trial of an additional exploratory product check remain part of the October 28 update. Explanations help me understand the mechanisms I am delegating. The trial asks whether the extra check finds something existing review and user testing miss. These practices are still being evaluated.

Useful lessons go into the existing Compound Engineering knowledge files with their context and rationale. A routine change may produce no reusable lesson. The aim is to make the next relevant task easier without filling the instructions with rules that apply everywhere.

## Development notes

These November 3 notes describe work in my development repository. The published tool folders remain dated source snapshots; the additions below are not included in those exports.

**Sorter: explain selection, then follow the outcome.** New reporting has merged into the development repository. It explains why issues stayed out of the working set and follows considered work through eligibility, selection, confirmed board placement, and later outcomes. A replay can test whether removing a particular rule would have changed admission, while reporting the coverage of the evidence.

That gives me a way to investigate an apparently surprising ranking. A high score can still sit outside Now because the work lacks definition, falls outside the milestone, or has no available slot. The [published method](../sorter/METHOD.md) explains those tradeoffs; the newer reports make their effects inspectable. The first outcome scorecard establishes a baseline. Its follow-up window is still maturing; ranking quality and delivery effects remain to be measured.

**Cleanup: narrow the automatic job.** The current development branch limits scheduled cleanup to merged, clean, inactive Windows checkouts. Dirty, unmerged, and complex recovery cases remain for supervised handling. It also keeps the installed executable version stable until an explicit reinstall. This is an application of the smallest-solution rule: automate ordinary completed work and preserve the operator's control over exceptions. Integration and installation of this narrower version are not confirmed in this snapshot.

## How the tools fit

- [AI intake](../ai-intake/) carries source evidence and acceptance criteria from findings into issues.
- [Sorter](../sorter/METHOD.md) applies my milestone priorities and capacity rules to the next working set.
- [Herdr coordinator](../herdr-coordinator/) supervises workers and brings questions back to the operator.
- [Worktree cleanup](../worktree-cleanup/) checks activity and recovery conditions before removing abandoned checkouts.

I built this setup for my own Windows workflow. Borrow the responsibility boundaries, review rules, or learning practices that fit your work, and adapt the tools to your environment. This page is a description of the method; the linked tool folders contain the published source and examples.
