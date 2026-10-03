# GitHub build action — standing reminders

Read this whenever the operator asks to run / trigger / cut a **GitHub Windows release candidate build**.

Workflow: `.github/workflows/build-release-candidate.yml`  
Trigger: **`workflow_dispatch` only** (manual). Do not leave `on: push` enabled.

## Build ≠ merge

| Ask | Do |
| --- | --- |
| “Do the build” / “cut an RC” | Dispatch the workflow on the named branch (`dev` or a tip). Upload artifacts. |
| “Merge everything” / “land all cursor branches” | **Stop.** That is a separate, high-risk decision. See below. |
| “Merge then build” | Confirm they mean merge `dev` → `main` after smoke, not a blind dump of every draft PR. |

## Why merging “everything” into `main` is dangerous

As of the #54 cleanup (`dev` @ integration tip):

- ~200+ commits / ~200+ files ahead of `main` in one stack.
- Alembic migrations `0014`–`0021` ship with the tip. If production ever ran a mid-stack branch with a different alembic history, `upgrade head` can fail or double-apply. `main` already needed an alembic chain fix once.
- Discord OAuth, invites, Roblox billing, and AI limits move together — hard to bisect if prod breaks.
- Git itself may be clean (no conflict markers); the risk is **runtime / DB / auth**, not merge conflicts.
- Public RCs were often built from WIP tips while `main` lagged — so players may already resemble `dev`, but **Railway/`main` deploy risk remains**.

**Safer default:** keep building from **`dev`**. Merge `dev` → `main` only after an explicit owner go-ahead and a short smoke (Discord sign-in, menu install/update, Plans/Roblox path).

## Do / don’t during a build session

**Do**

- Use `gh workflow run` / Actions UI `workflow_dispatch` on the intended ref.
- Confirm which SHA/branch is being built and report it back.
- Restore manual-only workflow if you had to touch triggers.
- Prefer `dev` when the operator says “build current” and `dev` is the integration tip.

**Don’t**

- Merge all open `cursor/*` draft PRs into `main` “so the build is complete.”
- Force-push `main` to the integration tip without an explicit “merge to main” from the operator after they’ve heard the risk.
- Reintroduce temporary `on: push` RC triggers as the lasting state.
- Recreate `docs/menu-update-model.md` or “GitHub-pinned menu” player copy (see #54).

## Related

- Repo-wide agent rules: `AGENTS.md`
- Release runbook: `docs/release.md`
- Integration branch: `dev`
