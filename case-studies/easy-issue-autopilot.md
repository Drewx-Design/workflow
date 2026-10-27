# Experiment note: Easy-Issue Autopilot

[Usage and experiment notes](../results/README.md).

I built an operator-invoked pipeline to reproduce a reported defect as a failing test, evaluate a candidate fix, and prepare it for review. Development has been paused since October 8, 2026; the unattended tier was never built. This note describes the experiment, whose source is not included in the public kits.

An issue can have acceptance criteria and still contain an unresolved product decision. Attempting to write checks made that distinction concrete: some issues needed a decision before a test could establish the right behavior. Calibration also showed that the verification pipeline needed further work.

Before the final attempt, I set a stopping rule: produce a green draft PR without hand repairs to the pipeline or a new gap. The attempt did not meet that bar, so I paused the separate autopilot.

The useful principle was **red-first reproduction**: establish a failing check on the original code, then test the change against it. The pause decision proposed carrying that discipline into ordinary debugging. Restarting the autopilot requires both:

1. At least five eligible issues with authored acceptance criteria open at the same time.
2. Ordinary debugging runs using the reproduction gate showing workers passing it without assistance.

The [intake tool](../ai-intake/) carries authored acceptance criteria alongside source evidence. The experiment clarified a further requirement: before automating a fix, establish that those criteria describe a settled decision and a checkable outcome.
