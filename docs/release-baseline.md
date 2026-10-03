# Release baseline and open pull requests

## Published GitHub Release

| Field                    | Value                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------- |
| Tag                      | `Engine_PreBeta` (“Pre Beta V1”)                                                      |
| Commit                   | `bfec4010f16d96fe27263869c76932f968a7fd5a` — _Refresh account deletion API contracts_ |
| Tagged                   | 2026-09-15 · published 2026-09-16                                                     |
| Target branch at publish | `main` as of that commit                                                              |

`main` has moved ahead of that tag (Alembic fix, later merges). **Do not assume Pre Beta == current `main` tip.**

## Unsigned Windows release candidates

CI workflow `Build unsigned Windows release candidate` uploads an artifact
`ii-engine-0.2.2-unsigned-candidate` for a specific commit SHA on a feature branch.
Those runs are **not** GitHub Releases. Each artifact belongs only to the commit that built it.
Record the Actions run URL and SHA whenever sharing a candidate.

## Why many draft PRs exist

Cloud Agent work lands as **stacked draft PRs** (one logical change per branch, each based on the previous tip). They are WIP review units, not a claim that production already ships each tip.

Until an owner merges a coherent stack onto `main` (or cuts a new tagged release from a chosen SHA):

- Production / Pre Beta remains the tagged baseline above.
- Newer Windows RC artifacts are evaluation builds only.
- Closing or merging drafts is an owner decision; agents must not force-merge the stack.

When publishing the next GitHub Release, name the exact commit SHA in the release body and in `docs/release.md` notes.
