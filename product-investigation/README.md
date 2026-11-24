# How I investigate product workflows

[Back to Workflow](../README.md).

I use this method to answer a product question before deciding what to build. It works for my own app, a comparison product, or a focused comparison between them. I added it as a shared agent skill on November 24; this page is the reusable method, not a report of measured results.

## Follow an action to its result

Start with one uncertainty, a defined starting state, and an observable outcome. For example: **does a qualification in the source survive review, saving, and later writing?**

This constructed probe shows how I would investigate it:

| Step | What to inspect |
| --- | --- |
| Supply a fictional source: “About 120 households received deliveries during the pilot.” | Keep the original wording and input. |
| Review the proposed fact. | Does it preserve “about,” the household unit, and the pilot period? |
| Accept it, save, and reload. | Inspect the saved object. A toast or chat acknowledgment alone does not establish persistence. |
| Ask for a later summary using that fact. | Check whether the qualification and unit survive reuse. |

When comparing products, use the same small scenario and record differences in prompts, source material, access tier, and human intervention. An instructed success demonstrates that instructed behavior; it does not establish the product's default behavior.

## Preserve what another person can check

Keep the question, date or revision, exact action, observed result, and enough source material or captures to reproduce the finding. Distinguish an observation from a reproduced result, a code-supported explanation, a vendor claim, and an untested hypothesis. If saving is blocked, downstream reuse remains untested.

For my own app, a bounded code read can help explain a mismatch between what is stored and what is displayed. For a comparison app, browser behavior does not establish its internal architecture.

## Connect the finding to the work

Check existing issues and shipped changes before proposing another issue. Record whether the finding belongs to an exact existing outcome, supplies related context, or needs a new intake decision. Keep parked ideas parked.

Save the smallest useful evidence set and a short continuation note: what was tested, what remains unknown, where the evidence lives, and what test data remains in the account. Research ends when the question is answered to that evidentiary limit or a concrete prerequisite blocks it. Implementation needs a separate decision.

Borrow the probe and evidence structure, using fictional or authorized material. The method is independent of a particular browser tool or operating system.
