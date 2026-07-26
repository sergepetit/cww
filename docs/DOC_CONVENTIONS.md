---
type: guide
title: Documentation Conventions
description: Frontmatter schema and the controlled type and status vocabularies for this repo's Markdown docs, and our take on OKF for project documentation
created: 2026-07-09
convention-version: 2
---

# Documentation Conventions

This document defines the conventions for human-authored Markdown documentation in this repository: every doc carries a small block of YAML frontmatter so the docs are consistent, queryable, and consumable by agents.

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
status: done                # optional — controlled vocabulary below, where the doc has a lifecycle
created: 2026-07-09         # optional — original authoring date
timestamp: 2026-07-10       # optional — last meaningfully updated (OKF "freshness" field)
tags: [docker, git]         # optional — free-form and unindexed; rarely worth adding
resource: https://...       # optional — only for docs that primarily point at an external thing
---
```

Rules:

- **`type`, `title`, `description` are always present.** `title` mirrors the H1; keep the H1 in the body too (frontmatter is for query, the H1 is for rendering).
- **`status`, `created`, `timestamp` are carried through only when the doc states them — never fabricated — and `status` is normalized onto the status vocabulary below.** When migrating older docs: `*Updated:*`/`*Last updated:*` → `timestamp`; `*Created:*` / `**Generated:**` / `**Date:**` → `created`; any bold/blockquote/heading "Status" → `status`. If a doc has no date, omit the date field rather than invent one.
- **One source of truth.** When a doc already carried metadata as an in-body italic/bold/blockquote line, move it into frontmatter and remove the redundant in-body line. Keep genuine subtitles/taglines — those are content, not metadata.
- **Dates** are written as the source doc wrote them (e.g. `January 2025` or `2026-06-25`); don't reformat existing dates.
- **`tags` is free-form and unindexed.** Nothing reads it — there is no tag index and no controlled tag list, and none is coming. Add a tag only for a cross-cutting concern that at least two docs in the folder share and that isn't already evident from `title` or `description`; otherwise omit. A tag matching one doc is a worse pointer than that doc's filename.
- **`resource`** is for docs whose substance is an external thing (a spec, a vendor page, a dashboard) — the doc points at it and summarizes; the URL belongs in frontmatter so it's queryable.
- **`convention-version`** appears only on this file. It records which version of the convention this repo adopted, so a later run can tell a stale copy from a deliberate local deviation. Don't add it to other docs, and don't change it by hand.

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

## The `status` vocabulary

Optional — most `guide` and `reference` docs have no lifecycle and omit it. When a doc has one, use exactly one of these, lowercase:

| `status` | Meaning |
|---|---|
| `draft` | The document itself is unfinished — stub sections, TODOs. |
| `proposed` | The document is complete; the work it describes is not agreed or started. |
| `agreed` | The work is decided and will happen, but hasn't started. |
| `active` | The work is underway, including partly shipped (phase 1 done, phase 2 not). |
| `done` | The work is complete and verified against code/reality. |
| `superseded` | Replaced by another doc — link the replacement in the body when one exists. |

- **The work's state wins.** Use `draft` only when the document itself is visibly unfinished; a rough write-up of work already underway is `active`.
- **`agreed` needs a recorded decision** — a dated note, a sign-off, an accepted proposal. Approval inferred from tone or plausibility is not approval: leave it `proposed`.
- **`status` is one word.** A qualifier ("all four phases host-verified", "two open decisions", "known limitation") is content: move it into the body and its date into `timestamp` in the same edit — never drop it.
- **Setting or changing a status is a meaningful update** — set `timestamp` in the same edit, so a reader can tell how old the claim is.
- **Nothing fits → omit the field.** `Exploration` is a `type`, not a status. Something removed is `type: tombstone`, not a status.

## Index files

Every docs folder (`docs/` and each subfolder) carries an `index.md` with `type: readme`: one line per doc, `- [FILE.md](FILE.md) — description`, the description lifted **verbatim** from the doc's frontmatter `description` (plus the `status` in italics when present). `docs/index.md` is the master index and also links to component READMEs elsewhere in the repo. Indexes are navigation aids in the LLM-wiki tradition — they contain no content of their own, so each entry regenerates from frontmatter. Where the index uses `##` group headings, the headings and each doc's placement under them are an editorial choice of this repo — preserve and extend them rather than re-deriving them. When adding, moving, or re-describing a doc, update the folder's `index.md` and the master index.

## Folder structure

Prefer a flat `docs/` — categorization lives in the `type` field, not in paths. Structure escalates in two steps, each only when the previous one stops working:

1. **Group the index.** When a folder's index mixes audiences or types enough to hurt scanning (roughly 6+ docs), group its entries under `##` headings by theme or type (e.g. "User documentation", "Plans", "Meta"). The files stay put; only the index changes. Once chosen, that heading set is the folder's grouping — a new doc goes under an existing heading, and a heading is added only when nothing fits.
2. **Split a subfolder.** When one `type` dominates a folder and keeps growing (typically `plan` — one plan doc per feature accumulates), move those docs into a subfolder (e.g. `docs/plans/`) with its own `index.md`, and replace their entries in the parent index with one line linking the subfolder's `index.md`. Moving is cheap — the path is not identity — but fix inbound links in the same change.

Don't create subfolders speculatively, and don't split by `status` (done vs. active) — status lives in frontmatter and changes; a doc shouldn't move when its status does.

## What we deliberately don't adopt

- **File-as-identity.** Docs are referenced by path as usual; we don't treat the path as a stable concept ID, and renaming a doc is fine.
- **Atomic-concept granularity.** Docs stay as cohesive multi-section narratives; we don't split a spec into one-file-per-concept.
- **A required `timestamp` on every file.** OKF wants one; we only set it where a real "updated" date exists.
- **A tag index or a controlled tag vocabulary.** OKF leaves `tags` producer-defined and says a tag-browsing view should be synthesized at consumption time rather than stored — we agree. Our controlled vocabularies are `type` and `status`: both closed, both single-valued, both checkable against a table. `tags` stays free-form, rare, and unindexed.
- **A concept graph.** No `ontology/` folder, no concept-per-file, no typed relations (`depends-on`, `part-of`) in frontmatter or anywhere else. Like OKF itself, we let a link be a link and leave the relationship to the prose. A term is defined in the doc that owns it, in one sentence at first use; if that stops working, the answer is one flat `GLOSSARY.md` with `type: reference`. Where the blast radius of a change matters, the answer is the code.

## Scope

These conventions apply to authored project documentation: `docs/` and the root `README.md`. They do **not** apply to generated files, example/config material (`examples/`, `templates/`), or Claude tooling manifests (`.claude/**`), which have their own formats.
