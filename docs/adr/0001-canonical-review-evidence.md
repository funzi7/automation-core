# ADR 0001 — Canonical exact-head review evidence

- Status: accepted
- Date: 2026-09-15
- Supersedes: the implicit rule `valid review == Codex review`

## Context

Every consumer repository gates merges on `check-codex-status`, published by
Codex Gate. Until now the gate, Merge Bot and the Claude Fallback Watchdog each
answered "has the current head been reviewed?" by looking for a genuine Codex
result bound to the exact head SHA. That assumption breaks whenever the
ChatGPT Codex connector reports that its **code-review quota is exhausted**:
the PR is fully green, fully reviewed by Claude Code, and still permanently
blocked because no Codex signal can ever arrive for that head.

The real case is paywall-bot PR #103 (head `d068d977`): exact-head CI green,
three earlier Codex rounds whose four P2 findings were all fixed and resolved,
then usage-limit notices at 02:13:50Z, 02:26:34Z, 09:49:02Z and 09:50:28Z, a
full Claude Code fallback review of the final head that found six further real
defects (including a regression the PR itself introduced), all fixed, suite at
661, state byte-clean — and a gate that stayed red purely for lack of a Codex
signal. OptionsProfitTracker PR #19 is in the same state today.

A free-form "Claude reviewed this" comment cannot be the answer: any actor can
write one. A per-repository patch cannot be the answer either: the contract
belongs in `automation-core`, where all three deciders live.

## Decision

The canonical contract is now:

```
valid exact-head review evidence ==
  normal Codex evidence
  OR approved Claude fallback evidence when Codex is provably unavailable
```

### Structured attestation, not prose

Fallback evidence is one atomic HTML marker:

```
<!-- claude-fallback-review:v1 run=<id> attempt=<n> pr=<n>
     provider=claude_code_fallback reviewed_head=<40-char SHA> verdict=clean
     findings_found=<N> findings_fixed=<N> unresolved_p1=0 unresolved_p2=0
     validation=passed/<reference> reason=codex_quota_unavailable -->
```

Every canonical field lives inside the marker, so a partially forged body
cannot contribute individual fields. Free-form prose parses to nothing.

### Only one workflow may mint it

`workflows/claude-fallback-review.yml` is the sole producer. It is
`workflow_dispatch`-only (GitHub restricts that to actors with write access),
refuses to run unless the repository sets `CLAUDE_FALLBACK_REVIEW_ENABLED`,
refuses unless dispatched from the default branch, checks out nothing, derives
`verdict` itself rather than accepting it, and refuses to attest when the
reviewed SHA is not the live head, when no trusted quota notice exists, when a
genuine Codex result already covers the head, or when a real Codex P1/P2 is
still active.

### Consumers re-authenticate everything

An attestation is a **necessary, never sufficient** condition. Codex Gate,
Merge Bot and the watchdog each re-verify, using the same proven model as the
existing `codex-head-epoch` markers:

- the comment was authored by `github-actions[bot]`;
- the referenced run and attempt resolve through the **authenticated** Actions
  API to a real run of `.github/workflows/claude-fallback-review.yml` (matched
  with any `@ref` suffix stripped — GitHub documents run-attempt paths as
  `build.yml@main` even though live responses return the bare path; the ref
  itself is pinned by the next rule);
- that run's event is `workflow_dispatch` and its `head_branch` is the default
  branch (a run from a PR ref would execute PR-controlled YAML);
- the comment was written inside the **current head epoch**: a branch that
  moves A → B → A starts a new epoch of A, and an attestation minted during the
  earlier epoch is not revived on the return
  (`attestation_predates_head_epoch`, with the same 5 s skew as the run window);
- the run **completed successfully** — a queued run would leave an open-ended
  authentication window, and a run that refused to attest proves nothing;
- the comment timestamp falls inside that run's execution window;
- the comment has never been edited (`updated_at === created_at`), because a
  body is mutable while `created_at` is not;
- any lookup failure ignores the attestation.

All three consumers also build the evidence inputs through the same shared
`collectReviewEvidenceInputs` collector. Byte-identical logic still drifts if
it is fed different sets, so the collector — not just the decision — is part of
the shared block.

### Trusted quota episodes

A quota notice counts only when the real Codex connector identity authored it
and the body matches the connector's own code-review usage-limit wording. An
episode is current in exactly two ways:

- **Route A** — the decline landed on this head epoch, and the fallback was
  attested no later than `QUOTA_EPISODE_TTL_MS` (24 h) after it. An attestation
  written *before* that notice is fine: the head-epoch binding already bounds
  it from below.
- **Route B** — the decline predates this head epoch, Codex has posted nothing
  since, and the fallback was attested within the same 24 h *after* it. Codex
  simply stops answering on later pushes while its quota is out, so demanding
  a fresh per-head notice would reject genuine exhaustion. PR #103 needs this:
  its last notice beats the final push by nine seconds, which is far too thin
  to depend on.

Any genuine Codex activity **at least as new as** the newest notice **closes**
the episode: REST timestamps carry one-second precision, so a same-second tie
cannot prove that the notice came last, and the tie fails closed. Without an
authenticated head-epoch observation there is no episode at all. A notice that
itself carries a P1/P2 marker is a finding, not proof of unavailability, and
never opens an episode (it counts as activity instead).

**Route A is bounded by the same TTL.** The original decision gave Route A no
expiry, reasoning that head-binding plus Codex's silence were observable facts
and that a wall-clock expiry would only turn a green PR red with nothing having
changed. Codex's review of the synced block (paywall-bot PR #107, 2026-11-08)
showed the gap in that reasoning: on a head that never moves, a months-old
on-epoch decline would authorize a *newly dispatched* fallback attestation,
although quota may have been restored long ago and nobody re-requested a Codex
review — the decline no longer describes the present. Route A is therefore
active only when the candidate attestation time is known and
`attestedAt − newestNotice ≤ 24 h`; an attestation minted more than 24 h after
the newest on-epoch decline is stale evidence of unavailability
(`stale_quota_evidence`). A negative difference is allowed because an
attestation written before the newest notice is already bounded from below by
the head-epoch binding. Nothing flips red merely because time passes: an
already-accepted attestation keeps its own fixed `attestedAt`, so the bound
constrains when a fallback may be *minted*, not how long an accepted one stays
valid. The reason codes are unchanged: `trusted_quota_episode` /
`stale_quota_evidence`.

### One shared decision

The three workflows carry the identical `CANONICAL EXACT-HEAD REVIEW EVIDENCE`
block verbatim; `tests/test_review_evidence.js` asserts it is byte-identical
across all three and that `tools/review_evidence.js` mirrors its reason codes.
Gate and Merge Bot therefore cannot drift into different verdicts.

### Precedence

1. administrator override / technical fail-soft — provenance claims no review;
2. active trusted Codex P1/P2 (thread or current-head non-inline) — blocked;
3. a fallback attestation declaring unresolved P1/P2 — blocked;
4. genuine current-head Codex evidence — clear, authority `codex`;
5. accepted fallback — clear, authority `claude_code_fallback`;
6. otherwise pending.

Findings are evaluated before any head signal, so a fallback can never erase
or bypass a real Codex finding, and a returning Codex review on the current
head always becomes the authority.

**Outdated is not resolved.** On the normal Codex path an outdated thread plus
a clean current-head Codex signal clears, because Codex itself re-examined the
new head. A fallback has no such re-examination, so the producer refuses to
mint evidence while ANY trusted Codex thread is unresolved, outdated or not:
otherwise pushing a cosmetic change over an unaddressed P1 would strand it in
an outdated thread that a fallback then cleared. Resolving the thread — which
means someone actually addressed the finding — is required. PR #103 is
unaffected: its four P2s were resolved, not merely outdated.

### Truthful provenance

The gate publishes `Codex exact-head review accepted` or
`Claude Code fallback review accepted for exact head; Codex quota unavailable`.
It never reports "Codex reviewed" for a Claude review.

### 2026-11-08 hardening

Trigger: Codex reviewed the synced `.github/workflows/codex-gate.yml` in
paywall-bot PR #107 and left six unresolved findings against this block. All
six are fixed in the canonical block (the three carriers stay byte-identical),
the producer, the mirror module and the tests. Every change narrows what is
accepted; none widens it.

1. **Timestamp ties close the episode (P2).** `evaluateQuotaEpisode` treats
   `newestReal >= newestNotice` as `quota_episode_closed`; the order of two
   items in the same second cannot be proven.
2. **Route A has a TTL (P1).** See above: the fallback must be attested within
   24 h after the newest on-epoch decline, otherwise `stale_quota_evidence`.
3. **Attestations bind to the current head epoch (P1).** In
   `acceptedFallbackEvidenceUnsafe`, when `headObservedAt` is known, a
   candidate whose comment predates it (5 s skew) is rejected with
   `attestation_predates_head_epoch` and scanning continues; the module applies
   the same rule to `attestedAt`. The binding only removes acceptance: a
   blocking attestation from an earlier epoch of the same SHA still blocks,
   because identical bytes carry identical findings.
4. **Candidates with inactive episodes no longer end the scan (P2).** The loop
   remembers the reason and continues, so a newer stale candidate cannot hide
   an older still-valid exact-head attestation. A blocking candidate still
   wins immediately. Diagnostics report the newest *authenticated* exact-head
   rejection in preference to a structural one.
5. **Run `path` with an `@ref` suffix (P1, defensive).** GitHub's documented
   example for "Get a workflow run attempt" shows `build.yml@main`; live
   responses on 2026-11-08 returned the bare path on both repositories.
   `attestationRunIsTrusted` compares the path with any `@…` suffix stripped,
   the ref being pinned by the `head_branch` rule. `trustedHeadMarkers`
   (outside the block) keeps its exact comparison.
6. **The producer counts reactions (P2).** `claude-fallback-review.yml` lists
   the PR's issue reactions and includes trusted Codex reactions in the
   newest-signal comparison, mirroring `collectReviewEvidenceInputs` exactly
   (a severity-carrying notice counts as activity there too, and a tie
   refuses). It refuses with a message naming the surface and the timestamps.
   Without this the producer could mint an attestation every consumer then
   rejected as `quota_episode_closed`.

## Consequences

- `codex-p1-acknowledged`, owner override and reaction acknowledgement keep
  their own distinct semantics and are never used to represent a fallback.
- Fallback is **off** until a repository sets `CLAUDE_FALLBACK_REVIEW_ENABLED`
  to `true`; the normal Codex path is unchanged everywhere else.
- A new commit invalidates the attestation, which is the intended cost: the
  reviewer must review the head that will actually merge.
- The 24 h bound is the only new time constant, and since 2026-11-08 it applies
  to both routes, measured from the newest notice to the attestation. It is
  deliberately generous enough for a real review cycle and short enough that
  an old decline cannot authorize a later fallback — on another head or on the
  same one.

## Alternatives rejected

- **Parsing a free-form Claude comment** — forgeable by any commenter.
- **Reusing `codex-p1-acknowledged`** — different semantics; it acknowledges a
  known finding rather than recording that a review happened.
- **Requiring a fresh quota notice on every head (Route A only)** — rejects the
  real PR #103 and OptionsProfitTracker #19 timelines, because the connector
  goes silent rather than re-declining on each push.
- **A per-repository patch** — the contract must be central; three deciders
  would drift immediately.
