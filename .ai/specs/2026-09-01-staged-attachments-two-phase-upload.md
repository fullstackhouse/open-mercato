# Staged attachments: two-phase upload with first-class unattached blobs

- Status: Draft (skeleton — Open Questions unresolved)
- Module: `packages/core/src/modules/attachments`
- Related specs: `2026-08-31-attachment-target-authorization.md` (PR #117 — the authorization seam this spec builds on), `2026-07-10-atomic-storage-quota-reservations.md` (the lifecycle skeleton), `2026-06-09-attachments-scope-invariant.md`

## 📝 TLDR

Uploading a file and binding it to a record are two different decisions, but Open Mercato's API forces
them into one request — so callers that don't have a target yet invent one. AI chat uploads against a
fake `entityId: 'ai-chat-draft'` with a minted per-batch UUID; create forms render with
`recordId ?? 'pending'`. This spec makes the unattached state real: **upload produces an unattached
blob authorized only by `attachments.upload`; a second `attach` mutation binds it to a target and runs
the mutation-guard registry against that target** — the same split Stripe, Slack, Shopify and Rails
ActiveStorage ship. The existing `POST /api/attachments` contract is kept forever as sugar (upload +
attach composed in one call), so nothing breaks; unattached blobs expire via a TTL sweeper riding the
quota-reservation state machine. Sequenced after PR #117, whose guard seam is the attach step's
authorization — this spec moves the check to its natural home rather than redoing it.

## ❓ Open Questions

- **Q1 — Data model.** Represent the unattached state as (a) a `status: 'staged' | 'attached'`
  column on `attachments` with `entity_id`/`record_id` made nullable while staged, or (b) a separate
  `attachment_staged_uploads` entity promoted into an `Attachment` row on attach? (a) keeps one
  table and one storage path but every existing query must exclude staged rows; (b) makes "library
  never sees staged files" structural but duplicates scope/quota/storage wiring. My lean: **(a)**,
  because the quota-reservation table already carries the risky lifecycle half.
- **Q2 — Interplay with PR #117.** Should #117 land as written (guard call in the upload route; this
  spec later moves it to the attach step), or should #117 be amended now so its Phase 1 targets the
  attach seam from the start? Landing as written ships protection sooner; amending avoids touching
  the same call sites twice. My lean: **land #117 as written** — the guard contract is
  location-independent and the org-scope bug fix shouldn't wait.
- **Q3 — Direct-to-storage uploads.** Is browser→storage presigned upload (via the storage hub) in
  scope as a phase here, or explicitly deferred with the endpoints merely *designed* to accommodate
  it (upload-session id + finalize callback)? My lean: **defer, design for it** — CORS, checksum
  verification and finalize callbacks are a spec of their own.
- **Q4 — Consumer migration scope.** Do the two fake-target consumers — AI chat (`ai-chat-draft`)
  and the CrudForm create-flow attachment field — migrate to staged blobs in this spec's phases, or
  as separate follow-up specs? Each is independently deployable. My lean: **AI chat in-spec** (it is
  the motivating hack and exercises the whole flow), **CrudForm create-flow as a follow-up spec**
  (it drags in form-state UX questions).
- **Q5 — TTL and quota semantics.** Default staged-blob TTL (proposal: **48h**, Rails-style), and do
  staged blobs count against the tenant storage quota until attached or expired (proposal: **yes**,
  via the existing committed reservation — prevents quota bypass by mass-staging)?
- **Q6 — Legacy endpoint fate.** Keep single-shot `POST /api/attachments` (with `entityId` +
  `recordId`) forever as a convenience composition (Stripe/GitHub keep single-shot paths), or
  deprecate it after ≥1 minor? My lean: **keep forever** — it is the right API for the common case
  where the target exists.

## 📝 Problem Statement

The single-request contract (`POST /api/attachments` returns `400` without `entityId` + `recordId`)
forces every caller to name a target at upload time. Where no target exists yet, the codebase fakes
one:

- **AI chat**: `useAiChatUpload` POSTs with `entityId: 'ai-chat-draft'` and "a per-batch UUID" as
  `recordId` (`apps/docs/docs/framework/ai-assistant/attachments.mdx:42`) — an unattached blob
  emulated through a sentinel target, invisible to any real record, with no lifecycle owner.
- **Create forms**: the attachment field renders with `recordId ?? 'pending'`
  (`fields/attachment.tsx:98`) — files cannot be uploaded until the record is saved, or must be
  re-pointed afterwards via transfer.
- **External API consumers** get a shape unlike the platforms they know (Stripe, Slack, Shopify all
  split upload from attach), and the platform cannot offer direct-to-storage uploads because the
  target must be authorized before the first byte is accepted.

Prior-art and failure-mode evidence (verified 2026-09-01, sources in the PR discussion): the
two-phase split is the industry-standard shape precisely because the *attach* step is where target
authorization naturally lives — Slack's `files.completeUploadExternal` fails with
`posting_to_channel_denied`; Stripe attaches an uploaded file to a dispute by *updating the
dispute*. The known cost is orphaned-blob lifecycle (Rails: "Using Direct Uploads can sometimes
result in a file that uploads, but never attaches to a record"), which this spec budgets for
explicitly rather than discovering in production.

## 📝 Proposed Solution (sketch — final shape depends on Q1–Q6)

1. **Staged upload endpoint** — `POST /api/attachments/uploads`: accepts the file (multipart, same
   parsing/quota/virus/partition pipeline as today) with **no target**; gated by
   `attachments.upload` (from #117's feature split) + session; returns a staged-blob id. Reuses the
   quota-reservation state machine; staged blobs carry an `expires_at`.
2. **Attach mutation** — `POST /api/attachments/:id/attach` with `{ entityId, recordId, fieldKey?,
   assignments? }`: resolves org scope via `resolveAttachmentOrganizationId`, runs
   `runRouteMutationGuards` with `resourceKind = entityId` / `resourceId = recordId` (#117's seam,
   at its natural home), then binds the blob and commits the reservation. Detach/re-attach follow
   the transfer rules from #117 (guard both ends).
3. **Legacy composition** — `POST /api/attachments` with `entityId`+`recordId` becomes internally
   "stage + attach" in one transaction-equivalent flow; wire format unchanged, so the
   `BACKWARD_COMPATIBILITY.md` route surface is untouched.
4. **TTL sweeper** — a queue worker expiring staged blobs past TTL: release reservation, delete
   stored object, delete row. Failure-mode budget: sweeper metrics + a CLI reconcile command,
   because silent orphan accumulation is *the* documented failure of this pattern.
5. **Consumer migration** (per Q4) — AI chat drops the `ai-chat-draft` sentinel for real staged
   blobs; message-send performs the attach.

Alternatives considered and rejected: keeping sentinel targets (unowned lifecycle, guard rules
cannot distinguish drafts from real targets); a fully DDD-pure design where only owning modules may
attach via their own mutations (correct in principle, but the generic attach endpoint + guard
registry already delegates the policy to owning modules/apps without forcing every module to grow an
attach route — modules can still wrap it); building this *instead of* PR #117 (the attach step needs
#117's guard seam, feature split and org resolution regardless — see Q2).

## 📝 Sections to be completed after the gate

Architecture · Data Model (incl. migration for Q1) · API Contracts · Edge Cases & Failure
Scenarios (sweeper races, attach-after-expiry, double-attach, quota exhaustion mid-stage) · Risks &
Impact Review · Phasing · Implementation Plan.

## Changelog

- 2026-09-01 — Skeleton drafted as the follow-up to PR #117 per maintainer direction ("avoid
  breaking changes twice" — resolution: one behavior change total, everything else additive).
  Open Questions pending maintainer answers.
