# Permit fixtures — committed, and deliberately unusable

These files exist to prove ONE thing that nothing else could prove: that the
PRODUCTION verification path — the committed keyring, the committed revocation
list, the machine's real clock — actually works, end to end, on material that
was signed elsewhere.

Every earlier test minted an ephemeral keypair into a temp directory and passed
its path in. That proved the algorithm and proved nothing about the boundary,
because the boundary is precisely the part a caller used to be able to choose.
`verifyPermit` and `verifyPermitFile` now take no trust inputs at all, so the
only way to exercise them is with material the repository already holds.

## What is here

| File | What the production loader does with it | Proves |
| --- | --- | --- |
| `expired-probe.manifest.json` | parsed and hashed | the manifest binding |
| `expired-probe.permit.json` | signature passes, then `PERMIT_EXPIRED` | the committed key really verifies a signature made off-machine, and the real clock is consulted |
| `revoked-probe.permit.json` | `PERMIT_REVOKED` | `data/permits/revoked.json` is genuinely read, before the clock is even considered |
| `tampered-probe.permit.json` | `PERMIT_BAD_SIGNATURE` | a body edited after signing is caught by the committed key |

`expired-probe.permit.json` is the important one. Reaching `PERMIT_EXPIRED`
means everything before the validity window passed for real: the key id resolved
to a committed `.pub`, the Ed25519 signature over the canonical body verified,
the revocation list was read, the manifest hash matched, and the methodology
hash matched the frozen sidecar. An expired permit proves the loader without
authorising anything.

## Why this is safe to commit

- Every fixture permit expired on **2020-01-02**. There is no clock the
  production path will accept them under, because the production path uses the
  machine's clock and takes no `now` parameter.
- They carry `budgetCapUsd: 0`, `evidenceClass: development-probe`, a `mock/`
  route and a run id (`wp0-fixture-expired`) that does not exist.
- `wp0-fixture-revoked-0001` is additionally on the revocation list.

## The key, and its private half

`data/permits/keys/wp0-fixture-2026-07.pub` is a **fixture** verification key. Its
private half was generated in an ephemeral sandbox, used once to sign the three
files above, and destroyed in the same session. It was never written to the
repository and never left that sandbox.

That is a real, if small, trust cost: a committed public key is a trust anchor,
and this one's private half cannot be audited, only asserted. It is accepted
because the alternative — a keyring that has never verified anything — is what
let RUN-001 be called closed while the chain had only ever run against keys the
tests themselves minted.

**Delete this key once a real approver key is committed.** Nothing but these
three expired fixtures depends on it, and a keyring should hold approvers, not
props.

## Regenerating

Do not try to re-sign these files: there is no private key, by design. Mint a
fresh disposable keypair, sign new fixtures, commit the new `.pub`, and delete
the old one. That is also what to do if the methodology sidecar ever changes —
`expired-probe.permit.json` names the frozen digest of
`docs/methodology/CookingBench-methodology-first-master-plan.md`, so a plan
revision invalidates it, exactly as it invalidates every real permit.
