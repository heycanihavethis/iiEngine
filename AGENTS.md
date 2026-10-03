# Agent notes (ii Engine)

## Cursor Cloud specific instructions

### GitHub build action (`Build unsigned Windows release candidate`)

When the operator asks to do the build, run the GitHub build, cut an RC, or trigger a Windows release candidate:

1. Do not merge `dev` (or the full Cloud Agent stack) into `main` as part of cutting a build. Trigger `workflow_dispatch` on the branch they named, often the WIP tip or `dev`, and leave `main` alone unless they explicitly say to merge first.
2. Keep `build-release-candidate.yml` on `workflow_dispatch` only. If you briefly enable push triggers to kick a build, restore manual-only in the same session and verify that restore is pushed.
3. Build from `dev` or an explicit tip rather than stale `main` while `dev` is ahead. `main` may lag the public RC tips by many commits.
4. If the operator asks to merge everything then build, note briefly that merging the full stacked tip (200+ commits, migrations `0014`–`0021`, Discord/Roblox/AI) into `main` without a staging smoke pass is risky. Build from `dev`, smoke Discord login, menu install and Plans/Roblox against staging/prod readiness, then merge `dev` into `main` as a separate step.
5. Full reminder detail: `docs/agent/github-build-reminders.md`.

### Integration branches (post #54)

- Central integration tip is `dev`, plus the PR that tracks it, for example `cursor/dev-integration-e90f`.
- Land into `dev`, build from `dev`, and merge `dev` into `main` when accepted. Do not reopen the pattern of many draft PRs with nothing on `main`.
- Player-facing menu copy stays plain ("Finding the latest verified menu…"). Do not reintroduce "GitHub-pinned" or "pin ships" wording for typical users.
- Do not recreate `docs/menu-update-model.md` unless the operator explicitly asks for that file.
