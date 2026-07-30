# WP-0 / v3 integration notes

Appended by each workstream, never overwritten. Each section says what the
integration pass must wire up or repair for that workstream's code.

## packages/core — v3 domain contract (schema.ts, types.ts, constructs.ts)

No new CLI command. The contract is types, zod schemas and pure predicates; every
v3 field is optional, so `bench validate` still reports 184 questions valid and
184 reference answers scoring 100 with no wiring change.

Two things the integration pass has to do:

1. **`packages/runner/src/judge.ts:47` will no longer typecheck.** The llm-judge
   `rubric` array is now `(RubricCriterion | AtomicCriterion)[]`, and an atomic
   criterion has no `name` or `description`. Replace

   ```ts
   return question.grader.rubric.map((c) => `${c.name}: ${c.description.trim()}`).join('\n');
   ```

   with

   ```ts
   return question.grader.rubric.map(criterionAttentionHint).join('\n');
   ```

   `criterionAttentionHint` is exported from `@cookingbench/core` and renders
   either shape. `isAtomicCriterion` is exported as a type guard if the judge
   needs to branch further (atomic criteria carry `kind`, `statement`, `weight`
   and an optional `dimension`).

2. **`questionSchema` is now a `ZodEffects`, not a `ZodObject`**, because the
   cross-field rules (dimension mode requires anchors; a KitchenPlan output
   contract requires a `kitchenPlanContract`; a criterion may not name an
   unanchored dimension) cannot live on the individual blocks. `.parse` and
   `.safeParse` are unaffected. Anything needing `.extend()`, `.pick()` or
   `.partial()` — authoring drafts, for instance — should use the exported
   `questionObjectSchema`, remembering that it does not carry those refinements.

Also worth knowing: `addedIn` now accepts `'v3'` (default is still `'v1'`), and
`resolveCraftWeights` throws unless given a full approval record. There is
deliberately no importable `CRAFT_WEIGHTS` constant — M1.5's weights are an
unapproved proposal and reaching them requires
`proposedCraftWeights('documentation-only' | 'sensitivity-analysis')`.
