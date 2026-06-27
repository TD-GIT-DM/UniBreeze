# Governing Principles for Code Development

These are the binding rules for every code change in this project. Consult them before AND after each step — not just at the start and end.

## The two base values (ranked)

1. **Make it better** — drive measurable progress toward the application's primary objective.
2. **Never make it worse** — never break, degrade, or destabilize anything that already works.

When the two conflict, **#2 prevails**: protecting what already works takes precedence over advancing the objective.

Progress is judged on real outcomes — features that work, behavior that's been verified — never on lines of code, activity, or surface appearance. The lever is **quality**: fewer, better, well-validated changes. Never volume, never by loosening a safety rail. If a change can't articulate how it serves the objective or protects what works, it doesn't ship.

## The 8-step workflow (sequential — each step gates the next, no skipping or reordering)

1. **Audit** the whole app, every surface — explicitly assess the change and current state against the governing principles: is the app on track toward its objective, and does anything threaten a regression?
2. **Scope** the change deeply, including every interconnected element it touches — state the case for the change against the governing principles (how it advances the objective and/or guards against regression).
3. **Optimize** — review and reduce code where possible; no bloat, no orphaned or duplicated paths.
4. **Deploy** — commit + push; CI deploys.
5. **Recheck impacts** — re-verify against the governing principles; confirm no safety rail was loosened and no new path can cause a regression or unintended behavior the user didn't opt into.
6. **Stress test** if possible.
7. **Smoke test** if possible.
8. **Report in lay terms** — including expected impact in normal use and expected effect on the governing principles (progress toward the objective; regression and stability protection).
