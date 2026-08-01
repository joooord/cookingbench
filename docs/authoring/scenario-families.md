# Scenario families — rationale

The machine-readable registry is `data/candidates/scenario-families.yaml`; this
doc explains why it exists and how to extend it.

## Why families, not just items

The v2.1 bank's central failure was that it measured far less than its item
count implied: 102 active items, effective count 24.2. Part of that is
saturation, but part is **hidden correlation** — items that look independent but
test the same narrow skill, so a model's score on one predicts its score on the
others and the bank's real resolving power is a fraction of its size.

M3.7 names the fix: variants of one scenario are not independent evidence, and
must be resampled together in the bootstrap. The `classification.scenarioFamily`
field carries the cluster id; this registry is the authority for which ids are
legal. Declaring the families **before** authoring (M1.8: "state the universe of
generalisation before sampling") stops the bank from accreting into whatever
shape the authors happened to find easy.

## How the registry is used

- `bench candidates` refuses an item whose `scenarioFamily` is not registered.
- It warns when a family holds more than four candidate items — a soft cap that
  keeps any single scenario from dominating (the M4.6 dominant-item concern).
- The coverage matrix in the WP-6a handoff counts items per blueprint family via
  the `blueprintFamily` field, so under-covered families are visible.

## The M1.8 coordinates

Each family declares three sampling coordinates, so the bank's coverage of the
intended population is inspectable:

- **context** — `domestic` | `professional` | `resource-limited`. M1.8 requires
  all three be represented. The registry is currently thin on
  resource-limited (one family) and light on professional (three); the file
  says so in its own footer, and the waves must add at least two more
  resource-limited families before the bank is sealed.
- **region** — where the family's terminology and conventions come from; `mixed`
  and `general` are legal. This is where regional measurement systems and
  culturally specific material get their coverage; culturally specific families
  need the history/culture reviewer at certification.
- **axis** — an informal tag for the culinary skill, for human scanning only;
  the binding capability tag is `classification.primaryCapability`
  (a `CRAFT_AXIS_ID`).

## Current Kitchen families

A family with `currentKitchen: true` holds dated/regulatory material (storage
guidance, recalls, jurisdiction-specific rules). M1.8 keeps these **separate**
from stable culinary reasoning so browsing recency never leaks into a reasoning
score. Items in these families must carry `asOf`, `jurisdiction` and a
next-review date. There is one such family now (`current-storage-guidance`, UK);
more will be added only with an owner who can keep them reviewed.

## Extending the registry

Add a family when a genuinely new scenario universe is needed — not to give one
more item a home. Every new family needs the three coordinates, a
`blueprintFamily`, an `evidenceLayer`, and a one-line summary of what it samples.
Adding a family is an authoring-time decision recorded here; it does not need a
decision-log entry unless it changes the declared population in a way that would
affect a claim (M1.8 coverage).
