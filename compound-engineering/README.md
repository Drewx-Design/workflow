# How I use Compound Engineering

[Back to the tools](../README.md).

I use Compound Engineering to move from a product question to a reviewed change. My adaptations divide responsibilities between models, keep implementation within the agreed scope, and carry useful lessons into the next task. I define the product goals and make the decisions that need my judgment.

The underlying method and plugin come from [Compound Engineering, maintained by Kieran Klaassen and Trevin Chow](https://every.to/guides/compound-engineering). This page describes my configuration and working rules as of **October 28, 2026**. The tools elsewhere in this repository support that workflow.

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

From October 26 to November 26, I am testing Kimi K3.1 Pro as an advisory fourth model family on roughly ten UI changes implemented without me present. It compares the code changes with the agreed plan, looking for unrequested controls, messages, states, or behaviors, as well as missing planned elements.

I track confirmed issues it finds that other reviewers missed, false flags, and the time needed to verify its findings. It receives evidence matched to the existing review so a richer brief does not get mistaken for a better model. The trial alternates `high` and `max` reasoning effort and stops early after five PRs if there are no confirmed unique catches or false flags exceed catches.

Kimi does not implement changes or replace the required reviews in this trial. Its findings must be checked against the plan and source before they affect a review decision. Results are pending.

## Rules that shape the work

**Settle disagreements with evidence.** Product alignment, implementation readiness, and architectural risk receive separate verdicts. Reviewers see the same frozen plan without each other's conclusions. A source-level finding needs a response grounded in code, tests, traces, or the agreed behavior; agreement between models does not settle it.

**Match review to the change.** Permissions, persistent data, concurrency, external interfaces, and irreversible rollout trigger additional scrutiny. Existing review coverage is reused when the artifact is unchanged. An amendment gets a focused review of the affected portion. If repeated amendments keep introducing new findings, the rule calls for a decision table or executable test to settle the contract.

**Check the version being delivered.** Verification records identify the code revision they checked. A source-only review is labeled as such. Workers cannot edit their way past a passing test result and still treat that earlier result as proof of the final change.

**Keep product scope explicit.** For hands-off UI work, the plan lists the controls, messages, and interaction states it requires. Workers report missing product decisions rather than adding new features on their own. The PR surfaces additions that cannot be traced to the plan so I can resolve them before merge. This scope-control practice was introduced on October 26; its effect is being evaluated.

## An example: narrowing a review role

On October 15, I reviewed how I was using Fable for design advice. The audit supported keeping it for design, interaction, and product-intent choices, while removing its automatic participation in infrastructure, test-policy, and other technical panels.

The reasoning mattered as much as the routing change. Counting how often I accepted an answer could measure agreement with me rather than quality. A separate review challenged that interpretation. The revised evaluation records an initial preference before consultation and calls for a blind assessment of whether the advice adds value.

The resulting rule is specific: use the design reviewer when a consequential design choice remains, and verify the facts supplied to it. Technical review continues through the repository and risk reviewers. This is a sanitized summary of my private October 15 calibration record; it documents a workflow decision, not a benchmark of model superiority.

## Keeping judgment and learning in the loop

My October 28 update makes product inspection at merge an explicit place to capture corrections and preferences. Only a preference I actually state can become guidance; approving a PR does not imply that I want every choice in it repeated.

The update also introduces a weekly explanation of recently merged work and a five-UI-PR trial of an additional exploratory product check. Explanations help me understand the mechanisms I am delegating. The trial asks whether the extra check finds something existing review and user testing miss. These are new practices whose results are still to be assessed.

Useful lessons go into the existing Compound Engineering knowledge files with their context and rationale. A routine change may produce no reusable lesson. The aim is to make the next relevant task easier without filling the instructions with rules that apply everywhere.

## How the tools fit

- [AI intake](../ai-intake/) carries source evidence and acceptance criteria from findings into issues.
- [Sorter](../sorter/METHOD.md) applies my milestone priorities and capacity rules to the next working set.
- [Herdr coordinator](../herdr-coordinator/) supervises workers and brings questions back to the operator.
- [Worktree cleanup](../worktree-cleanup/) checks activity and recovery conditions before removing abandoned checkouts.

I built this setup for my own Windows workflow. Borrow the responsibility boundaries, review rules, or learning practices that fit your work, and adapt the tools to your environment. This page is a description of the method; the linked tool folders contain the published source and examples.
