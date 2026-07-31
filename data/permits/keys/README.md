# Permit verification keys

Ed25519 **public** keys only, one per file, PEM/SPKI, named `<keyId>.pub`.
`keyId` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` — it is used as a
filename component and is validated, not sanitised.

## Why there is no private key here, and never will be

The permit is the only thing standing between the runner and spending money or
publishing a board. If the signing key were reachable by Claude, Codex, the
runner or CI, then the system that enforces approval could approve itself, and
the whole layer would be decoration with a cryptographic accent.

So: **the private key lives offline with Jordan.** Minting a permit is a human
act performed away from this repository. This directory holds only what is
needed to *verify*, which is public by design.

## Generating a keypair (run this somewhere the repo cannot see)

```sh
openssl genpkey -algorithm ed25519 -out cookingbench-permit-2026.key   # keep offline
openssl pkey -in cookingbench-permit-2026.key -pubout -out cookingbench-permit-2026.pub
```

Commit only the `.pub`.

## Signing a permit

The signature is over the **canonical JSON** of the permit body — keys sorted
recursively, as produced by `canonicalJson()` in `packages/core/src/evidence.ts`.
Ordinary `JSON.stringify` uses insertion order, so a permit built field-by-field
in a different sequence would hash differently and fail to verify. The envelope
on disk is:

```json
{ "permit": { ... }, "signature": "<base64 Ed25519>", "keyId": "cookingbench-permit-2026" }
```

## Verification is not just the signature

`verifyPermit()` also enforces, after the signature passes: that the permit does
not name its own revocation source, revocation, manifest-hash binding,
methodology-hash binding, the run id the command is acting on, the validity
window, the permit-kind × capability matrix, the permit-kind × evidence-class
matrix, cell coherence against the manifest's declared routes, and that the
permit's budget does not exceed the manifest's. A valid signature proves *who*
approved the work — not that the work was allowed to be that.

Expiry and revocation are re-checked every time authority is EXERCISED
(`assertGrantStillValid`), not only when the permit was loaded. A run takes
hours; a permit that expires or is withdrawn mid-run stops working mid-run.

## This directory is the trust root, and callers cannot change it

`verifyPermit` and `verifyPermitFile` take **no** keyring, revocation or clock
parameter. They previously did — "injectable for testability" — which meant any
caller could point verification at a key it had just minted, or move the clock
past an expiry. Tests reach a separate seam (`verifyPermitForTests`) that
production source never calls and that refuses to run outside a test process.

## Status

One key: `wp0-fixture-2026-07.pub`. It is a **fixture** key, not an approver key
— see `../fixtures/README.md`. Its private half was generated in an ephemeral
sandbox, used once to sign three already-expired permits, and destroyed. It can
authorise nothing, and it should be deleted when a real approver key is
committed.

No approver key has been committed and no usable permit has been minted, so no
capability can currently be exercised: verification fails closed with
`PERMIT_UNKNOWN_KEY` for anything else, and `Firewall.denyAll()` remains the only
reachable posture. That is the correct state for a repository under code
preparation.
