# Attachment target authorization: guards, feature split, and one organization scope

- Status: Draft
- Module: `packages/core/src/modules/attachments`
- Related specs: `2026-06-09-attachments-scope-invariant.md`, `2026-07-05-attachment-metadata-assignment-layout.md`

## TLDR

`POST /api/attachments` carries the target it is about to write (`entityId` + `recordId`), but the
only authorization it runs is `requireFeatures: ['attachments.manage']` — a single tenant-wide
feature that cannot tell "set my own avatar" from "replace an organization's logo". Apps that need
a per-target rule cannot express it, so they reimplement route matching outside the framework.
Three concrete changes fix that, plus one open question:

1. Run the existing **mutation-guard registry** from every attachment write route, keyed on
   `resourceKind = entityId` / `resourceId = recordId`.
2. **Split `attachments.manage`** so storage-partition administration and deletes are not implied by
   "may upload a file".
3. Use **one organization-resolution function** across all attachment routes — today upload and
   library/transfer disagree, and the disagreement is a real bug that no app can work around.
4. Decide whether `matchRoutePattern`'s case-insensitive segment comparison is deliberate.

Items 1 and 3 touch the same module and should ship as one PR; item 2 is independent and small.

**Scope boundary.** After this lands, an application expressing "only the owner may attach to a
user record" ships roughly twenty lines in its own `data/guards.ts` (see Architecture). Core
supplies the seam, the payload and the scope; the application supplies the policy.

## Problem Statement

### How the gap presents to an application

Applications routinely need rules of the form "a user may set their own avatar" or "only an
organization's admin may replace that organization's logo". Both are statements about the *target*
of the upload, not about the uploader's tenant-wide powers.

**What this spec delivers is the seam, not those rules.** Core has no avatar or logo feature and
should not acquire one: whether an admin may set someone else's avatar is product policy. The
deliverable is that an application can express such a rule at all — today it cannot, at any price,
without reimplementing route matching outside the framework.

Systems that authorize this correctly tend to do it in two steps: uploading a file requires nothing
but a signed-in session, and *what the file becomes* is authorized by the mutation that consumes it.
On Open Mercato both halves are the same request. `POST /api/attachments` receives `entityId`,
`recordId` and the file together, and the route's only gate is `attachments.manage`. There is no
seam at which "which target is this?" can be asked. An application is left with two options, and
both are wrong:

- **Grant `attachments.manage` to everyone** — every signed-in account can then overwrite the
  organization logo, delete anybody's attachment in the organization, and reconfigure storage
  partitions.
- **Withhold it from non-admins** — staff invited into an organization can then upload nothing at
  all, their own avatar included, because an invitation grants the membership role and nothing else.

So applications take a third option, outside the framework: a target guard of their own — in the
case that prompted this spec, ~350 lines wired into the app's API dispatcher — which enumerates
core's attachment write endpoints, resolves the route with `matchRoutePattern` against the generated
manifest, parses the body once, and refuses writes whose target the caller may not touch. Such a
guard only ever narrows, since core's checks still run first, but it duplicates a concern the
framework already models elsewhere, it silently misses every attachment endpoint added later, and it
has to be re-derived by every application with the same need.

The single-request contract leaks inside core too, which is the clearest evidence that "name your
target at upload time" is the wrong shape: AI chat uploads invent a target, posting
`entityId: 'ai-chat-draft'` with a minted per-batch UUID as `recordId`
(`packages/ui/src/ai/upload-adapter.ts:16`; documented in
`apps/docs/docs/framework/ai-assistant/attachments.mdx:42`), and the CrudForm attachment field
renders `recordId ?? 'pending'` on create (`attachments/fields/attachment.tsx:98`). Neither caller
has a target yet; both fake one because the API demands it.

### The four gaps in core

#### 1. Attachment write routes do not run the mutation-guard registry

`@open-mercato/shared/lib/crud/mutation-guard-registry` models exactly this concern: a module
registers a guard in `data/guards.ts` declaring `targetEntity` (wildcards supported via
`matchesEntity`) and `operations`, and `runRouteMutationGuards`
(`packages/shared/src/lib/crud/route-mutation-guard.ts:119`) calls it with `resourceKind`,
`resourceId`, `tenantId`, `organizationId`, `userId`, `requestMethod`, `requestHeaders` and
`mutationPayload`.

The CRUD factory runs it (`packages/shared/src/lib/crud/factory.ts:705`) and so do hand-written core
routes — `communication_channels` wraps it in
`packages/core/src/modules/communication_channels/lib/route-mutation-guard.ts`, and the
`warranty_claims` module calls `runRouteMutationGuards` from a dozen routes. Opting in from a
hand-written route is an established pattern.

The closest precedent is an attachment write route itself:
`warranty_claims/api/portal/attachments/route.ts:130` loads the target claim, verifies ownership, and
calls `runRouteMutationGuards` with the claim as `resourceKind`/`resourceId` — exactly the shape this
spec proposes, already shipping in core.

The `attachments` module opts into neither guards nor API interceptors. There is no
`packages/core/src/modules/attachments/data/guards.ts`, and no call to `runRouteMutationGuards`
anywhere under the module.

**So gap 1 is compliance debt, not novel design.** `packages/core/AGENTS.md` → API Routes already
mandates that custom write routes wire the mutation-guard contract; `attachments` simply does not.
Phase 1 brings one module into line with a rule the repository already states and other modules
already follow — it does not ask maintainers to accept a new mechanism.

**Consequence.** Any app needing per-target rules on attachments must reimplement route matching
outside the framework, and every endpoint added to the module later silently escapes those rules.

#### 2. `attachments.manage` is one feature for five different powers

The single feature (`packages/core/src/modules/attachments/acl.ts:3`) gates all of:

| Endpoint | Power |
| --- | --- |
| `POST /api/attachments` (`api/route.ts:54`) | upload a file against any target |
| `DELETE /api/attachments` (`api/route.ts:55`) | delete any attachment in scope |
| `PATCH` / `DELETE /api/attachments/library/<id>` (`api/library/[id]/route.ts:48-49`) | edit metadata; delete (drops the stored blob too) |
| `POST /api/attachments/transfer` (`api/transfer/route.ts:22`) | repoint attachments at another record |
| `GET`/`POST`/`PUT`/`DELETE /api/attachments/partitions` (`api/partitions/route.ts:63-66`) | create, edit and delete storage partitions |

The last row is storage *configuration*, not content. An app that wants the very ordinary rule "any
signed-in user may attach a photo" (avatars, profile pictures) must simultaneously grant deleting
anyone's attachment in the organization and reconfiguring the storage layout. `attachments.view` is
similarly coarse: it opens `GET /api/attachments/library`, i.e. the organization's whole attachment
library including private partitions.

Note that `attachments/setup.ts:5` already grants `admin` the wildcard `attachments.*`, so a split
is backwards compatible for the seeded roles — `authorizeFeatures`
(`packages/shared/src/security/featurePolicy.ts:59`) matches `*` and `<prefix>.*` grants.

#### 3. Attachment routes disagree about which organization they are acting in

`POST /api/attachments` and `DELETE /api/attachments` resolve the organization via
`resolveAttachmentOrganizationId` (`api/route.ts:339`, `api/route.ts:682`) — the **selected**
organization, cookie-driven and RBAC-validated (`lib/requestScope.ts`, added for #3765), because
`auth.orgId` is not selected-organization aware for non-superadmins.

`PATCH` / `DELETE /api/attachments/library/<id>` (`api/library/[id]/route.ts:159`, `:241`) and
`POST /api/attachments/transfer` (`api/transfer/route.ts:49`) instead filter on raw `auth.orgId`.
`GET /api/attachments/library` (`api/library/route.ts:84`) does too.

Two consequences, both reproduced against this repository:

- An attachment uploaded while organization B was selected carries `organization_id = B`, but the
  library routes look it up under the caller's home organization — **the owner cannot delete their
  own file through that route**, it 404s. `DELETE /api/attachments?id=` works, because it resolves
  the scope the same way the upload did.
- An upload whose `record_id` points outside the resolved scope is stored, but any consumer that
  matches scope against target never reads it back — the upload silently produces nothing. The
  best an app-level guard can do is return `403` here, which is a workaround, not a fix.

**This is the only item an app cannot fix for itself.** An app can refuse a request; it cannot make
core's own query look in a different scope.

#### 4. Open question: is case-insensitive route matching deliberate?

`matchRoutePattern` (`packages/shared/src/modules/registry.ts:348`) compares literal path segments
with `uSegs[i].toLowerCase() !== seg.toLowerCase()`, so `/api/Attachments` matches the
`/api/attachments` route. Any app-level logic keyed on the request URL will therefore disagree with
the router about which endpoint was hit. An app-level guard keyed on the raw URL can therefore be
walked around unless it uses the framework's own matcher.

If deliberate, it deserves a line in the routing docs. If not, it should be tightened.

## Related Upstream Work

| Ref | Relationship |
| --- | --- |
| #4717 *No avatar/photo field on auth.User — first-class column, or attachments?* | Open, unanswered. Asks whether user avatars should be an `auth.User` column or an attachment, and closes with "can a user change their own avatar, and can an admin change another user's?". It assumes the attachment route "needs no upstream change" — this spec is the reason that assumption does not hold, and Phase 1's exported `auth:user` guard is the mechanism that would answer its final question. |
| #2152 *feat(attachments): declare ACL feature dependencies* | **Overlaps Phase 2 — same file.** Per-module follow-up to #2141, enacting `.ai/specs/2026-05-27-acl-dependency-bundles.md` §6.12 on `attachments/acl.ts`. That spec calls its table a "proposed default" module owners may refine. Phase 2 therefore lands the split **and** the `dependsOn` declarations together, and closes #2152. |
| #3312 *bug(sync_excel): wire upload and import writes through mutation guards* | Same defect class as gap 1, labelled `priority-high` / `risk-high`, in a route that also creates an attachment. Two independent reports of one shape is the evidence behind R5 and behind the follow-up proposed under "Beyond attachments". |
| #5726 *RFC — actor-aware command guard policy* | Adjacent, not overlapping: command layer, not route layer. Its **structural vs workflow** guard taxonomy is adopted here — an attachment target guard is *structural* (an invariant binding every caller), so it is not a candidate for the `trustedReplication` relaxation that RFC proposes for workflow guards. |

## Proposed Solution

### Phase 1 — Guard every attachment write by its target

#### 1a. The dispatch collision, and the `surface` discriminator

The registry selects guards on a **single key**: `matchesEntity(guard.targetEntity,
input.resourceKind)` (`mutation-guard-registry.ts:102`). `makeCrudRoute` puts the *entity being
written* in `resourceKind` (`factory.ts:1051`, derived from the ORM entity name).

If attachment writes put the **target** entity in that same field, the two meanings collide: a guard
declaring `targetEntity: 'auth:user'` to mean "who may attach a file to a user" also fires on every
ordinary update of a user record, and a guard meaning "who may edit this user" fires on attachment
writes aimed at it. Under the naive design, an app guard reading
`resourceKind === 'auth:user' && resourceId !== userId → 403` would block an administrator editing
another user's profile through plain user CRUD.

**Fix — an additive optional discriminator.** Extend the shared registry types:

```ts
// packages/shared/src/lib/crud/mutation-guard-registry.ts
export type MutationSurface = 'crud' | 'attachments'

export interface MutationGuardInput {
  // …existing fields…
  /** Which write surface raised this mutation. Defaults to 'crud'. */
  surface?: MutationSurface
}

export interface MutationGuard {
  // …existing fields…
  /** Surfaces this guard applies to. Omitted = every surface (today's semantics). */
  surfaces?: MutationSurface[]
}
```

Dispatch gains one filter: a guard declaring `surfaces` runs only for those surfaces; a guard
omitting it keeps firing everywhere, so **every existing guard is unaffected** — the optimistic-lock
floor and the `customer_accounts` domain rules included. Both fields are optional additions to
existing types, which `BACKWARD_COMPATIBILITY.md` classifies as compatible.

**Payload sniffing is explicitly rejected** as the alternative. Distinguishing the two meanings by
inspecting `mutationPayload` for attachment-shaped keys makes dispatch depend on request content,
fails silently when a payload shape changes, and cannot be typed. The discriminator is declared by
the caller that knows the answer.

> **Note — this takes the spec beyond the attachments module.** The `surface` discriminator is a
> change to `packages/shared`, i.e. to a contract surface. It is additive and optional, but the
> claim "no framework changes" no longer holds and the API Contracts table records it.

#### 1b. Where the guard is invoked

Guard calls go behind one module-local helper, `lib/attachmentMutationGuard.ts`, whose signature is
**target-shaped, not route-shaped**:

```ts
assertAttachmentTargetWritable({
  container, req, auth,
  target: { entityId, recordId },
  operation: 'create' | 'update' | 'delete',
  payload,
})
```

Nothing in that contract names a route, so the call site can move without the contract changing —
which matters because the staged-uploads follow-up relocates it (see *Forward compatibility* below).

> **Open point for maintainers.** The review asks for enforcement inside `attachmentService` rather
> than at route call sites, so a future route cannot forget it. That is the right end state, but
> **the service is not a choke point today**: `POST /api/attachments` writes directly
> (`em.create(Attachment, …)` at `api/route.ts:552`, `tx.persist(att).flush()` at `:572`), transfer
> uses `em.persist(records).flush()` (`api/transfer/route.ts:75`), library delete uses
> `em.remove(record).flush()` (`api/library/[id]/route.ts:255`), and the only consumer of
> `attachmentService` in the repo is `packages/documents` through a port. Routing the four write
> paths through the service is a prerequisite refactor of a 762-line route file that this spec does
> not currently scope.
>
> **On the related question of the upload seam:** this spec deliberately keeps the guard at the
> upload path as it exists today, rather than aiming it at the future `attach` mutation. The guard
> contract is location-independent, the Phase 3 organization-scope fix is a live bug that should not
> wait on a spec with six unresolved questions, and the relocation is mechanical once staged uploads
> land. Shipping protection sooner wins.
>
> This spec is written for the **interim shape**: the helper above, called from the write paths,
> target-shaped so relocation is mechanical. The alternative — do the service refactor inside this
> spec — is viable but roughly doubles Phase 1 and touches code the staged-uploads spec will rewrite
> anyway. Maintainer's call; the guard contract is identical either way.

Call sites and their target resolution:

| Write path | `resourceKind` | `resourceId` | `operation` |
| --- | --- | --- | --- |
| `POST /api/attachments` | form `entityId` | form `recordId` | `create` |
| `DELETE /api/attachments` | loaded record's `entityId` | loaded record's `recordId` | `delete` |
| `PATCH /api/attachments/library/<id>` | loaded record's `entityId` | loaded record's `recordId` | `update` |
| `DELETE /api/attachments/library/<id>` | loaded record's `entityId` | loaded record's `recordId` | `delete` |
| `POST /api/attachments/transfer` | body `entityId` | **both** `fromRecordId`/record's current `recordId` **and** `toRecordId` | `update` |
| `POST`/`PUT`/`DELETE /api/attachments/partitions` | `attachments.partition` | partition code | `create`/`update`/`delete` |

Design points:

- **Transfer clears the bar at both ends.** Repointing an attachment is setting (or removing) an
  image by another name; a guard that only sees the destination lets an editor strip an
  organization's logo by moving it away. Run the guard once per end.
- **The delete routes resolve the target from the stored row**, not from the request, so a caller
  cannot mis-declare it. This is the direct fix for a real vulnerability class: Vikunja
  GHSA-jfmm-mjcp-8wq2 (CVSS 8.1) — *"the permission check validates access to the task specified in
  the URL, but the handler loads a different attachment that may belong to a task in another
  project"*.
- **The upload's guard runs before the blob is written and before quota is reserved**, so a refusal
  leaves no orphaned storage or reservation.
- **Guards see the payload.** Pass the parsed non-file form fields (and the transfer body) as
  `mutationPayload` so a guard can inspect `fieldKey`, tags and assignments.

Because the module currently parses multipart before it knows anything else, the upload guard call
lands right after `const entityId = ...` / `const recordId = ...` in `api/route.ts` and after the
container is created — the `resolveRouteUserFeatures` lookup needs the container.

In the taxonomy of #5726 these are **structural** guards — invariants that must bind every caller —
not workflow guards, so they are deliberately outside the scope of that RFC's `trustedReplication`
relaxation.

With no guards registered the registry returns `ok: true`, so this change is behaviour-preserving
for every existing install.

**Ship one ready-made guard, opt-in.** Self-ownership of a user record is computable without domain
knowledge (`resourceKind === 'auth:user' && resourceId === userId`), and #4717 asks precisely this
question about avatars. Export `selfOwnedUserAttachmentGuard` from the module so an application
enables the rule with one line instead of re-deriving it. It is **not** registered by default:
installs where an administrator legitimately sets another user's attachment would regress silently.

**Document the one-call path.** `packages/core/AGENTS.md` → API Routes currently instructs custom
write routes to assemble the registry by hand (`getAllMutationGuardInstances()` +
`bridgeLegacyGuard()` + `runMutationGuards()`) and never mentions `runRouteMutationGuards`, which
does exactly that in one call and also resolves `userFeatures`. That omission is why every adopter
so far has written its own local wrapper. Update the section to point at the helper.

**This is the write-side twin of an existing read-side primitive.** `AttachmentTargetAccessService`
(`attachments/lib/target-access-service.ts`, DI-registered as `attachmentTargetAccessService` in
`di.ts:19`, consumed by `warranty_claims` in `ai-tools.ts` and `api/ai/assess/route.ts`) already
answers "may this caller reach that target?" for reads via `canAccessLinkedTarget`. Writes have no
equivalent. Phase 1 supplies it through the registry rather than by growing a second bespoke service.

#### 1c. The guard convention this spec establishes

This is Open Mercato's **first cross-module guard usage** — existing guards are either infrastructure
(the optimistic-lock floor) or a module policing its own entity — so the convention set here is the
one every later module copies. State it explicitly:

- **Guards are module-scoped.** Each module ships policy for **its own** entities in its own
  `data/guards.ts`: `auth` guards `auth:user`, `customers` guards `customers:deal`. A module never
  ships policy about another module's entities.
- **`targetEntity: '*'` is reserved for infrastructure** (locking, auditing) — never for domain
  policy. An app-wide guard switch-boarding over every entity is an anti-pattern: with a hundred
  modules using attachments it becomes one file containing a hundred modules' rules, which is
  exactly the unbounded growth this convention exists to prevent.
- **The blessed primary path for domain flows**, once staged uploads land, is the owning module's
  own mutation calling the attach operation — which authorizes with that module's RBAC and then runs
  the same guard dispatch. The generic endpoint plus guards is the **safety net** for generic UI and
  for user-defined custom entities, which have no module to host an attach endpoint.

#### 1d. What this seam cannot express

Guards **only narrow**. They cannot grant, so "authorize by relationship alone, with no feature at
all" — a caller holding no `attachments.upload` still being allowed to set their own avatar — stays
inexpressible here. The realistic cases are covered by granting `attachments.upload` broadly (to
`employee`, per Phase 2) and letting guards narrow from there; a relationship-only grant needs a
module-owned route, the shape `warranty_claims` already uses for its portal attachment endpoint.

A tri-state `allow | deny | abstain` policy registry would lift the limitation and was rejected: it
forces feature checks out of declarative route metadata into handler bodies, which is where
authorization decisions become invisible to review.

#### 1e. Forward compatibility with staged uploads

The maintainer direction is that a follow-up spec introduces two-phase upload (first-class unattached
blobs, then an `attach` mutation), matching Stripe, Slack, Shopify and Rails ActiveStorage. Under
that design **the upload call site moves to the `attach` mutation** — but the guard contract
(`resourceKind` / `resourceId` / `operation` / `surface`) is location-independent, which is why 1b
specifies a target-shaped helper. Everything else in this spec — the feature split, organization
unification, and the delete/transfer guard sites — carries over unchanged.

Two-phase does not remove the target check; it **relocates** it (Slack's `files.completeUploadExternal`
fails with `posting_to_channel_denied`; Stripe attaches evidence by updating the dispute). So this
spec is not an alternative to the industry pattern — it builds the authorization seam that pattern
needs, at the only place the target is currently known.

### Phase 2 — Split the ACL features

New feature ids in `attachments/acl.ts`:

| Feature | Gates |
| --- | --- |
| `attachments.view` | unchanged — library reads |
| `attachments.upload` | `POST /api/attachments` |
| `attachments.delete` | `DELETE /api/attachments`, `DELETE /api/attachments/library/<id>` |
| `attachments.manage` | retained: metadata edit (`PATCH .../library/<id>`) and `POST /api/attachments/transfer` |
| `attachments.partitions.manage` | `POST`/`PUT`/`DELETE /api/attachments/partitions` (`GET` stays on `attachments.view`) |

Dependency declarations, merged from #2152 (the `dependsOn` field is live — see
`packages/core/src/modules/customers/acl.ts`, the reference module):

| Feature | `dependsOn` | Rationale |
| --- | --- | --- |
| `attachments.view` | — | |
| `attachments.upload` | **—** | The load-bearing line: uploading an avatar does not require read access to the organization's library. Making `upload` depend on `view` would defeat the split — an employee would again see everything. |
| `attachments.delete` | `attachments.view` | Deleting deliberately implies being able to see what is deleted |
| `attachments.manage` | `attachments.view` | As proposed in `2026-05-27-acl-dependency-bundles.md` §6.12 |
| `attachments.partitions.manage` | `attachments.view` | |

This refines §6.12's two-row table, which that spec explicitly labels a proposed default open to
module owners. Phase 2 therefore closes #2152 rather than colliding with it, and inherits its
acceptance criteria: update `defaultRoleFeatures` in `setup.ts`, run
`yarn mercato auth sync-role-acls` after deploy so existing tenants pick up the new ids, and assert
`resolveAclDependencyDiagnostics` reports no `unknownReferences` for the module.

Backwards compatibility (per `BACKWARD_COMPATIBILITY.md`, ACL features are ADDITIVE-ONLY):

- `attachments.manage` is **not removed** and keeps gating what it gates today for the routes listed
  above; the new ids are added alongside. Routes that move to a narrower feature list
  `requireFeatures: ['attachments.upload']` **or** the legacy `attachments.manage` — expressed as a
  wildcard-friendly grant check rather than a hard swap — for at least one minor version.
- `attachments.*` wildcard grants (already used by the seeded `admin` role) pick up every new id
  automatically.
- `setup.ts` grants the new ids to `admin` explicitly; `employee` keeps `attachments.view` and gains
  `attachments.upload` — the rule an application cannot express today without its own guard.
- Document the migration in `UPGRADE_NOTES.md` and mark the old-vs-new mapping with `@deprecated`
  JSDoc where the legacy id is still accepted.

### Phase 3 — One organization resolution

Replace every raw `auth.orgId` filter on an attachment row with `resolveAttachmentOrganizationId`:

- `api/library/route.ts` (list + tag query)
- `api/library/[id]/route.ts` (GET, PATCH, DELETE)
- `api/transfer/route.ts`

and keep the superadmin "All organizations" fallback the delete route already documents (`orgId`
resolves to `null` ⇒ tenant-only filter).

Then close the silent-write hole: `POST /api/attachments` should **refuse** an upload whose target
falls outside the resolved organization scope rather than storing a row nothing will read back. The
scope invariant spec (`2026-06-09-attachments-scope-invariant.md`) already asserts rows may not be
partially null; this extends the same reasoning to the target. A `403`/`400` an operator can act on
beats an empty image with no explanation.

**This phase changes behaviour** and must be called out in `UPGRADE_NOTES.md`: a multi-org admin who
previously uploaded a logo without switching organizations got a `200` and an invisible file; they
now get an error. In the application where this was reproduced, turning the rule on made five
previously-"passing" tests fail, each of which had been asserting a success the image projection
would never return — the failure is the finding, not the cost.

### Phase 4 — Route matching case sensitivity

Raise as a decision, not a change: either document `matchRoutePattern`'s case-insensitive literal
segment comparison in the routing docs, or tighten it to a case-sensitive compare behind one
release of deprecation notice. Tightening is a FROZEN-surface change (routing behaviour) and needs
its own spec if chosen.

**Independently of which way that goes**, the routing docs should state that authorization logic
keyed on a request URL **MUST** resolve the route through the framework's own `matchRoutePattern`
rather than matching path strings itself. URL-shape-keyed authorization sitting outside the router is
precisely what gets bypassed — cf. Next.js GHSA-f82v-jwr5-mffw (CVSS 9.1), where middleware-layer
authorization was bypassed wholesale. That guidance is useful whether or not the comparison changes,
and it is the part that protects applications today.

## Architecture

```
POST /api/attachments
  requireAuth + requireFeatures(attachments.upload | attachments.manage)   ← Phase 2
  parse multipart → entityId, recordId, fieldKey, file
  createRequestContainer()
  orgId = resolveAttachmentOrganizationId(container, auth, req)            ← Phase 3 (everywhere)
  assertAttachmentTargetWritable({ target: { entityId, recordId },         ← Phase 1
                                   operation: 'create',
                                   surface: 'attachments',
                                   payload: formFields })
    └─ registry: guards from every module's data/guards.ts
       + bridgeLegacyGuard(container)
       filtered by matchesEntity(targetEntity, entityId), operation,
                   surface, features
  assert target within orgId scope                                         ← Phase 3
  quota reserve → storage write → row insert → crud side effects
  runAfterSuccess()
```

Policy lives with the module that owns the entity — **one guard per owned entity, never one
switchboard over all of them**. The module owning user records ships:

```ts
// <module owning auth:user>/data/guards.ts
export const guards: MutationGuard[] = [
  {
    id: 'auth.user-attachment-target',
    targetEntity: 'auth:user',
    surfaces: ['attachments'],          // ← does not fire on ordinary user CRUD
    operations: ['create', 'update', 'delete'],
    priority: 20,
    async validate({ resourceId, userId }) {
      return resourceId === userId
        ? { ok: true }
        : { ok: false, status: 403, message: 'Not your record' }
    },
  },
]
```

and, independently, the module owning organizations ships its own guard for
`targetEntity: 'directory:organization'`. Neither knows about the other; adding a hundred modules
adds a hundred small guards, not one growing file.

Without `surfaces: ['attachments']` this guard would also fire on every ordinary update of a user
record and lock administrators out of profile editing — see Phase 1a.

An application adopting this deletes its dispatcher wiring, its route-matching table, its
per-request body cache and its manifest-drift unit test.

## Alternatives Considered

| Alternative | Why not |
| --- | --- |
| **Owner-module attach endpoints only, no guards** | Right as the *primary* path and adopted as such (Phase 1c), but insufficient alone: user-defined custom entities have no module to host an endpoint, the shared attachment UI is generic over all entities, and the frozen generic endpoint stays alive either unguarded (the Vikunja IDOR class) or admin-locked (the under-grant this spec exists to fix). |
| **A dedicated `AttachmentTargetPolicy` interface** | Collision-free by construction, but duplicates ~90% of the registry (matching, priority, feature gating, after-success), adds a second frozen contract surface with the same job, and contradicts the standing mandate in `packages/core/AGENTS.md` to wire custom write routes through the guard contract. |
| **Payload sniffing instead of a `surface` field** | Makes dispatch depend on request content, fails silently when a payload shape changes, cannot be typed, and hides the decision from review. The caller knows which surface it is; it should say so. |
| **Tri-state `allow \| deny \| abstain` policy registry** | Would lift the deny-only limitation (Phase 1d), but forces feature checks out of declarative route metadata into handler bodies, making authorization decisions invisible where reviewers look for them. |
| **Central policy engine / ReBAC (Zanzibar-style)** | Wrong weight class for one module's target check; introduces a new subsystem, its own consistency model and a migration for every existing guard. |
| **Two-phase upload now, instead of this spec** | Two-phase relocates the target check rather than removing it, so it needs this seam regardless. Sequenced the other way there is exactly one behaviour change ever (the Phase 3 organization fix, required under any design) and the staged-upload work lands additively on top. |

## Data Models

No schema changes. `Attachment.entityId` / `Attachment.recordId` / `Attachment.organizationId`
already carry everything the guards need.

## API Contracts

| Surface | Change | Compatibility |
| --- | --- | --- |
| `POST /api/attachments` | may now return `403` from a registered guard; returns `400`/`403` when the target is outside the resolved org scope | ADDITIVE status codes; the org-scope refusal is a behaviour change (Phase 3) |
| `DELETE /api/attachments` | may now return `403` from a guard | additive |
| `PATCH`/`DELETE`/`GET /api/attachments/library/<id>` | scope resolved from selected org, not `auth.orgId` — **fixes** existing 404s | behaviour change, strictly more correct |
| `POST /api/attachments/transfer` | guard runs on both ends; scope from selected org | additive + behaviour change |
| `/api/attachments/partitions` | write methods move to `attachments.partitions.manage` (legacy `attachments.manage` still accepted for one minor) | additive |
| `attachments.upload`, `attachments.delete`, `attachments.partitions.manage` | new ACL feature ids | ADDITIVE-ONLY, per contract |
| `MutationGuardInput.surface`, `MutationGuard.surfaces` (`packages/shared`) | new optional fields on the guard registry types; omitting them preserves today's fire-on-every-surface dispatch | additive optional fields on existing types — compatible per `BACKWARD_COMPATIBILITY.md`; **this spec therefore changes a shared contract surface, not only the attachments module** |

## Risks & Impact Review

| # | Failure scenario | Severity | Area | Mitigation | Residual |
| --- | --- | --- | --- | --- | --- |
| R1 | Phase 3 refuses uploads that previously "succeeded" (multi-org admin without the org selected) — an existing integration breaks | Medium | attachments upload | `UPGRADE_NOTES.md` entry; error message names the fix ("select the organization first"); the previous success stored an unreadable row | Apps relying on the invisible row must switch org before uploading |
| R2 | Phase 2 narrowing locks an operator out because their role holds only the legacy `attachments.manage` | High | RBAC | Legacy id keeps working on every route for ≥1 minor; `attachments.*` wildcard grants cover the new ids; `setup.ts` reconciler adds them | An app that hard-coded the exact grant list and disabled seeding must update |
| R3 | Guard added to the upload path after the blob is written would orphan storage/quota on refusal | High | storage/quota | Guard call placed before quota reservation and driver write; integration test asserts no row **and** no stored object after a refusal | — |
| R4 | Transfer guarded on one end only lets a caller strip a privileged image by moving it away | High | authorization | Guard runs for both source and destination record ids; integration test for the move-away case | — |
| R5 | A future attachment write route is added without a guard call, silently escaping app rules | Medium | maintainability | The target-shaped helper is the only sanctioned write path; unit test enumerates write routes from the generated manifest and fails if one has no guard call. **Not hypothetical:** #3312 reports the same omission in `sync_excel`, in a route that also creates an attachment. Moving enforcement inside `attachmentService` would retire this risk structurally rather than by test — see the open point in Phase 1b | Until the service is a genuine choke point, the manifest test is the only backstop |
| R8 | A guard written for the `crud` surface fires on attachment writes (or vice versa), blocking legitimate edits | High | authorization | The `surface` discriminator (Phase 1a); guards that omit `surfaces` keep today's semantics, so the risk exists only for guards that opt in and mis-declare; unit test asserts an `auth:user` attachment guard does **not** fire on plain user CRUD | — |
| R6 | Guard resolution adds a per-upload RBAC lookup (`resolveRouteUserFeatures`) | Low | performance | One lookup per request, already paid by every CRUD route; skipped entirely when no guard matches the entity | — |
| R7 | Phase 3 widens what a library route can see (selected org may differ from home org) | Medium | tenancy | `resolveOrganizationScopeForRequest` is RBAC-validated — the selection is rejected if inaccessible; integration test asserts a cross-tenant selection is refused | — |

## Test Plan

Unit (`packages/core/src/modules/attachments/api/__tests__/`):
- guard invoked with the right `resourceKind`/`resourceId`/`operation` for each of the six write
  surfaces;
- upload refusal leaves no stored object and no quota reservation;
- transfer calls the guard once per end;
- write-route enumeration from the generated manifest matches the guarded set;
- legacy `attachments.manage` still authorizes each newly-split route;
- `resolveAclDependencyDiagnostics` reports no `unknownReferences` for the module's own ids (#2152);
- `selfOwnedUserAttachmentGuard` permits a user's own `auth:user` record and refuses a foreign one,
  and is absent from the registry unless explicitly registered;
- a guard declaring `surfaces: ['attachments']` fires on an attachment write against `auth:user` and
  does **not** fire on an ordinary `auth:user` CRUD update — and a guard omitting `surfaces` fires on
  both, proving the discriminator is backwards compatible.

Integration (`packages/core/src/modules/attachments/__integration__/`):
- a guard refusing `auth:user` for a foreign record produces `403` on upload, delete, library delete
  and transfer;
- library `PATCH`/`DELETE` now succeed for a file uploaded under a non-home selected organization
  (the 404 regression from gap 3);
- upload targeting a record outside the resolved scope is refused;
- partition writes require `attachments.partitions.manage`; `GET` still works on `attachments.view`.

## Sequencing

1. **PR A** — Phases 1 + 3 (same module, same routes, one review).
2. **PR B** — Phase 2 (independent, small, ACL + setup + upgrade notes). Closes #2152.
3. **Issue** — Phase 4, a maintainer decision.
4. **Comment on #4717** — the attachment route to user avatars is viable, but not without Phase 1;
   the exported guard answers that issue's closing question.

### Beyond attachments

The defect is not attachment-specific: `makeCrudRoute` enforces the registry, a hand-written write
route enforces it only if its author remembered. Counting `route.ts` files under
`packages/core/src/modules` that export a `POST`/`PUT`/`PATCH`/`DELETE` handler: **269 such files,
of which 35 reference the guard registry**, spread over six modules (`warranty_claims` 16,
`communication_channels` 13, `sales` 2, `eudr` 2, `push_notifications` 1, `configs` 1) — attachments
zero. (Counts differ with scope: including every workspace package raises the denominator. The
method above is stated so the figure can be reproduced.) #3312 is the same omission in `sync_excel`.

A general fix is deliberately **not** in this spec — the mechanism already exists and is sound, so
what is missing is enforcement, and enforcement touches every one of those routes. That belongs in
its own spec, best written once this module is a worked example. A purely declarative route-metadata
approach would not suffice on its own: `ModuleRoute` has no target concept today, and delete routes
must resolve the target from the stored row rather than the request.

Until A and B land and a release carrying them is available, applications needing per-target rules
keep their own dispatcher-level guard; that guard can be deleted once the registry runs from the
module's own routes.

## Final Compliance Report

- No cross-module ORM relationships introduced; guards receive ids only.
- Tenant/organization scoping is tightened, never loosened, except where `auth.orgId` is replaced by
  the RBAC-validated selected-organization resolution.
- ACL changes are additive; the legacy feature id keeps working for ≥1 minor version with
  `@deprecated` JSDoc and an `UPGRADE_NOTES.md` entry, per `BACKWARD_COMPATIBILITY.md`.
- No generated files edited by hand; the write-route manifest test reads generated output.
- No new production dependencies.
- User-facing refusal messages route through `t('attachments.errors.*')`.

## Changelog

- 2026-08-31 — Spec drafted from an application-level report of the gap, grounded against
  `packages/core/src/modules/attachments` at commit `7f871e603`. Not yet implemented.
- 2026-09-01 — Maintainer review round (fork PR #117). Fixed a design defect: attachment writes and
  ordinary CRUD writes collided on `resourceKind`, so Phase 1a adds the additive optional `surface` /
  `surfaces` discriminator to the shared registry types — which takes this spec beyond the
  attachments module onto a shared contract surface. Phase 1 restructured: target-shaped helper
  (relocatable when staged uploads land), the module-scoped guard convention this spec establishes as
  precedent, the deny-only limitation named, forward-compatibility with two-phase upload, and the
  read-side twin `AttachmentTargetAccessService`. Architecture example rewritten from an app-wide
  `'*'` switchboard to per-entity module-owned guards. Added "Alternatives considered"; strengthened
  Phase 4 with the "URL-keyed authz must use `matchRoutePattern`" mandate; cited Vikunja
  GHSA-jfmm-mjcp-8wq2 and Next.js GHSA-f82v-jwr5-mffw; added the in-repo evidence that the
  single-request contract leaks (`ai-chat-draft`, `recordId ?? 'pending'`); added risk R8; corrected
  the registry-adoption count from "three modules" to 35 files across six modules, with the counting
  method stated. Open point recorded for maintainers: enforcement inside `attachmentService` requires
  a prerequisite refactor, since the service is not a choke point today.
- 2026-09-01 — Surveyed open upstream issues/PRs and added "Related upstream work" (#4717, #2152,
  #3312, #5726). Phase 2 absorbs #2152's `dependsOn` declarations and acceptance criteria; Phase 1
  gains the opt-in `selfOwnedUserAttachmentGuard` and an `AGENTS.md` fix pointing custom write
  routes at `runRouteMutationGuards`; R5 cites #3312 as evidence; added "Beyond attachments".
