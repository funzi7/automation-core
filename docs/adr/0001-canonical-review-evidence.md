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
  API to a real run of `.github/workflows/claude-fallback-review.yml`;
- that run's event is `workflow_dispatch` and its `head_branch` is the default
  branch (a run from a PR ref would execute PR-controlled YAML);
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

- **Route A** — the decline landed on this head epoch. The head has not moved
  and Codex has not returned, so the decline still describes the present.
- **Route B** — the decline predates this head epoch, Codex has posted nothing
  since, and the fallback was attested within `QUOTA_EPISODE_TTL_MS` (24 h) of
  it. Codex simply stops answering on later pushes while its quota is out, so
  demanding a fresh per-head notice would reject genuine exhaustion. PR #103
  needs this: its last notice beats the final push by nine seconds, which is
  far too thin to depend on.

Any genuine Codex activity newer than the newest notice **closes** the episode.
Without an authenticated head-epoch observation there is no episode at all. A
notice that itself carries a P1/P2 marker is a finding, not proof of
unavailability, and never opens an episode.

**Route A deliberately carries no TTL.** A decline that landed on this head
epoch stays valid while the head does not move and Codex does not answer,
because both of those are observable facts rather than assumptions: any new
commit invalidates the attestation outright, and any Codex activity closes the
episode. Adding a wall-clock expiry here would turn a green PR red after a
fixed delay with nothing having changed, which is churn without a safety gain.
The anti-staleness requirement is met by head-binding plus Route B's 24 h bound,
which is where an *older* episode could otherwise leak into a *later* fallback.

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

## Consequences

- `codex-p1-acknowledged`, owner override and reaction acknowledgement keep
  their own distinct semantics and are never used to represent a fallback.
- Fallback is **off** until a repository sets `CLAUDE_FALLBACK_REVIEW_ENABLED`
  to `true`; the normal Codex path is unchanged everywhere else.
- A new commit invalidates the attestation, which is the intended cost: the
  reviewer must review the head that will actually merge.
- Route B's 24 h bound is the only new time constant. It is deliberately
  generous enough for a real review cycle and short enough that an old decline
  cannot authorize an unrelated later fallback.

## Alternatives rejected

- **Parsing a free-form Claude comment** — forgeable by any commenter.
- **Reusing `codex-p1-acknowledged`** — different semantics; it acknowledges a
  known finding rather than recording that a review happened.
- **Requiring a fresh quota notice on every head (Route A only)** — rejects the
  real PR #103 and OptionsProfitTracker #19 timelines, because the connector
  goes silent rather than re-declining on each push.
- **A per-repository patch** — the contract must be central; three deciders
  would drift immediately.
