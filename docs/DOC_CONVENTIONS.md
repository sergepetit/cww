---
type: guide
title: Documentation Conventions
description: Frontmatter schema and the controlled type vocabulary for this repo's Markdown docs, and our take on OKF for project documentation
created: 2026-07-09
---

# Documentation Conventions

This document defines the conventions for Markdown documentation in this repository: every doc carries a small block of YAML frontmatter so the docs are consistent, queryable, and consumable by agents.

## Why — our take on OKF

Google's Open Knowledge Format (OKF) formalizes the "LLM-wiki" pattern: a directory of Markdown files, each with YAML frontmatter carrying a few queryable fields (`type`, `title`, `description`, `resource`, `tags`, `timestamp`), plus the convention that the file path is the concept's identity and cross-links are wiki-style.

**We adopt OKF's frontmatter *vocabulary*, but deliberately not its file model.**

- **Adopt:** the frontmatter field names (`type` / `title` / `description` / `tags` / `timestamp`). Standardizing these makes the docs queryable ("all `type: plan` with `status: draft`") and gives agents a one-line `description` for retrieval instead of grepping prose. It's cheap — it formalizes a pattern many docs already approximate with bold `**Status:**` headers.
- **Don't adopt:** OKF's "one concept per file" and "file path = identity" rules. Our docs are intentionally *multi-concept narrative documents* (the user guide covers every command; the git-strategy doc covers cloning, credentials, and workflows). OKF's atomicity rule is for knowledge atoms, not guides. We take the vocabulary and leave the granularity rule.

## Frontmatter schema

```yaml
---
type: plan                  # required — one of the controlled vocabulary below
title: Bun Migration Plan   # required — mirrors the document's H1
description: One-line summary used for retrieval and relevance.   # required
status: proposed            # optional — lifecycle/status, where the doc has one
created: 2026-07-09         # optional — original authoring date
timestamp: 2026-07-10       # optional — last meaningfully updated (OKF "freshness" field)
tags: [docker, git]         # optional — topical tags
resource: https://...       # optional — only for docs that primarily point at an external thing
---
```

Rules:

- **`type`, `title`, `description` are always present.** `title` mirrors the H1; keep the H1 in the body too (frontmatter is for query, the H1 is for rendering).
- **`status`, `created`, `timestamp` are carried through only when the doc states them — never fabricated.** When migrating older docs: `*Updated:*`/`*Last updated:*` → `timestamp`; `*Created:*` / `**Generated:**` / `**Date:**` → `created`; any bold/blockquote/heading "Status" → `status`. If a doc has no date, omit the date field rather than invent one.
- **One source of truth.** When a doc already carried metadata as an in-body italic/bold/blockquote line, move it into frontmatter and remove the redundant in-body line. Keep genuine subtitles/taglines — those are content, not metadata.
- **Dates** are written as the source doc wrote them (e.g. `January 2025` or `2026-06-25`); don't reformat existing dates.

## The `type` vocabulary

| `type` | Meaning |
|---|---|
| `feature-spec` | Specification/design of a product feature. |
| `plan` | A plan or proposal for work to be done (often time-bounded). |
| `guide` | How-to / setup / conventions reference for contributors. |
| `reference` | Stable technical reference (architecture, product spec, structured lists). |
| `audit` | A point-in-time review/assessment of the codebase or a subsystem. |
| `log` | A running, append-mostly record (e.g. a code-review log). |
| `exploration` | Research, comparisons, or idea collections that aren't committed plans. |
| `pitch` | Sales/investor/marketing-facing material. |
| `readme` | Entry-point README for a component or directory. |
| `tombstone` | A pointer doc for a removed feature, redirecting to current docs. |

## Index files

Every docs folder (`docs/` and each subfolder) carries an `index.md` with `type: readme`: one line per doc, `- [FILE.md](FILE.md) — description`, the description lifted **verbatim** from the doc's frontmatter `description` (plus the `status` in italics when present). `docs/index.md` is the master index and also links to component READMEs elsewhere in the repo. Indexes are navigation aids in the LLM-wiki tradition — they contain no content of their own, so they can always be regenerated from frontmatter. When adding, moving, or re-describing a doc, update the folder's `index.md` and the master index.

## Folder structure

Prefer a flat `docs/` — categorization lives in the `type` field, not in paths. Structure escalates in two steps, each only when the previous one stops working:

1. **Group the index.** When a folder's index mixes audiences or types enough to hurt scanning (roughly 6+ docs), group its entries under `##` headings by theme or type (e.g. "User documentation", "Plans", "Meta"). The files stay put; only the index changes.
2. **Split a subfolder.** When one `type` dominates a folder and keeps growing (typically `plan` — one plan doc per feature accumulates), move those docs into a subfolder (e.g. `docs/plans/`) with its own `index.md`, and replace their entries in the parent index with one line linking the subfolder's `index.md`. Moving is cheap — the path is not identity — but fix inbound links in the same change.

Don't create subfolders speculatively, and don't split by `status` (done vs. active) — status lives in frontmatter and changes; a doc shouldn't move when its status does.

## What we deliberately don't adopt

- **File-as-identity.** Docs are referenced by path as usual; we don't treat the path as a stable concept ID, and renaming a doc is fine.
- **Atomic-concept granularity.** Docs stay as cohesive multi-section narratives; we don't split a spec into one-file-per-concept.
- **A required `timestamp` on every file.** OKF wants one; we only set it where a real "updated" date exists.

## Scope

These conventions apply to authored project documentation: `docs/` and the root `README.md`. They do **not** apply to generated files, example/config material (`examples/`, `templates/`), or Claude tooling manifests (`.claude/**`), which have their own formats.
