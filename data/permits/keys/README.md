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

`verifyPermit()` also enforces, after the signature passes: revocation,
manifest-hash binding, methodology-hash binding, the validity window, the
permit-kind × capability matrix, the permit-kind × evidence-class matrix, cell
coherence against the manifest's declared routes, and that the permit's budget
does not exceed the manifest's. A valid signature proves *who* approved the
work — not that the work was allowed to be that.

## Status

Empty. No permit has been minted, so no capability can currently be exercised:
verification fails closed with `PERMIT_KEYRING_UNAVAILABLE` or
`PERMIT_UNKNOWN_KEY`, and `Firewall.denyAll()` remains the only reachable
posture. That is the correct state for a repository under code preparation.
