/**
 * M1.2 — the TRN-inspired table model.
 *
 * Michael Chu's tabular recipe layout (cookingforengineers.com) is the
 * inspiration for the *renderer* and nothing else. Ingredients are rows down
 * the left; each operation is a cell merged across the rows it draws on, and
 * the columns march left to right until the dish arrives at the right-hand
 * edge. It reads well because it is a picture of the dependency graph, which is
 * exactly what a KitchenPlan already is.
 *
 * This module is a pure data-to-table transform, and that split is deliberate:
 * candidates are asked for JSON, never for a drawn table. Asking a model to
 * emit ASCII art would measure its patience with box-drawing characters, and
 * the plan says the table "is one canonical renderer, not the semantic
 * contract". We render it ourselves so the thing being measured is the culinary
 * structure underneath.
 *
 * No React, no DOM, no strings-with-markup: the return value is a structure the
 * web app lays out, plus a linearised step list so a screen reader gets the
 * same information as the grid.
 */
import type { KitchenPlan, PlanOperation } from './types.js';
import { buildPlanGraph, type PlanGraph } from './kitchenplan.js';

export const TRN_ROW_KINDS = [
  /** A declared ingredient, drawn once. */
  'ingredient',
  /** A component already drawn above, pointed at rather than redrawn. */
  'back-reference',
  /** An operation with no inputs at all needs a row to sit on. */
  'operation-source',
  /** An ingredient that reaches the plate untouched. */
  'served-directly',
  /** Declared and never used. Shown, never hidden — see below. */
  'orphan',
] as const;
export type TrnRowKind = (typeof TRN_ROW_KINDS)[number];

export interface TrnRow {
  index: number;
  kind: TrnRowKind;
  /** Ingredient or output id; empty for an `operation-source` row. */
  nodeId: string;
  label: string;
  /** Pre-formatted for display; the numbers stay in the plan. */
  quantity?: string;
  allergens?: string[];
  state?: string;
  note?: string;
  /** `back-reference` rows only: the row carrying the real sub-table. */
  refersToRow?: number;
}

export interface TrnCellDetail {
  duration?: string;
  temperature?: string;
  equipment?: string[];
  sensoryTarget?: string;
  attention?: 'active' | 'passive';
  startAtMinute?: number;
}

export interface TrnCell {
  operationId: string;
  /** 0 is the ingredient column; operations start at 1. */
  column: number;
  rowStart: number;
  rowSpan: number;
  label: string;
  outputs: { id: string; name: string; state: string }[];
  detail: TrnCellDetail;
}

export interface TrnStep {
  order: number;
  operationId: string;
  /** Assembled from the plan's own fields — no invented instruction text. */
  summary: string;
  inputs: string[];
  outputs: string[];
  startAtMinute?: number;
}

export interface TrnTable {
  renderable: true;
  title: string;
  servings: number;
  locale: string;
  serviceAtMinute: number;
  serviceClock?: string;
  columnCount: number;
  rows: TrnRow[];
  cells: TrnCell[];
  /**
   * Components feeding more than one operation. A table cannot merge one cell
   * into two separated row blocks, so the second use is drawn as a
   * back-reference row. Surfacing the ids lets the renderer annotate the link
   * instead of the reader wondering why a component appears twice.
   */
  sharedComponents: string[];
  /** Indexes of `orphan` rows, so a renderer can mark them without scanning. */
  orphanRows: number[];
  steps: TrnStep[];
}

export const TRN_REFUSALS = ['duplicate-id', 'unresolved-input', 'cycle', 'no-root'] as const;
export type TrnRefusal = (typeof TRN_REFUSALS)[number];

export interface TrnRefusalResult {
  renderable: false;
  reason: TrnRefusal;
  message: string;
  subjects: string[];
}

export type TrnResult = TrnTable | TrnRefusalResult;

/**
 * Lay a plan out as a dependency table.
 *
 * Refuses rather than renders when the graph is broken. A table drawn from a
 * plan with an unresolved input would silently drop the missing branch and look
 * perfectly convincing, which is worse than no table: the renderer would be
 * concealing the exact fault the validator exists to find. Orphan ingredients
 * are the opposite case — they are shown, in their own rows with no cell, so
 * the fault is visible on the page.
 */
export function buildTrnTable(plan: KitchenPlan): TrnResult {
  const graph = buildPlanGraph(plan);

  if (graph.duplicateIds.length > 0) {
    return {
      renderable: false,
      reason: 'duplicate-id',
      message: `ids declared more than once: ${graph.duplicateIds.join(', ')}`,
      subjects: graph.duplicateIds,
    };
  }
  if (graph.unresolvedInputs.length > 0) {
    const subjects = graph.unresolvedInputs.map((u) => u.input);
    return {
      renderable: false,
      reason: 'unresolved-input',
      message: `operations consume things that do not exist: ${graph.unresolvedInputs
        .map((u) => `${u.operation} → ${u.input}`)
        .join(', ')}`,
      subjects,
    };
  }
  if (!graph.order) {
    return {
      renderable: false,
      reason: 'cycle',
      message: `the plan is cyclic and cannot be laid out left to right: ${(graph.cycle ?? []).join(' → ')}`,
      subjects: graph.cycle ?? [],
    };
  }

  const roots = findRoots(plan, graph);
  if (roots.length === 0) {
    return {
      renderable: false,
      reason: 'no-root',
      message: 'every operation output is consumed by another operation, so the plan has no finished dish',
      subjects: [],
    };
  }

  const rows: TrnRow[] = [];
  const cells: TrnCell[] = [];
  const rowOfIngredient = new Map<string, number>();
  const spanOfOperation = new Map<string, { rowStart: number; rowEnd: number; column: number }>();
  const sharedComponents: string[] = [];

  const pushRow = (row: Omit<TrnRow, 'index'>): number => {
    const index = rows.length;
    rows.push({ ...row, index });
    return index;
  };

  /** Depth-first over inputs; rows are emitted in reading order as we go. */
  const visit = (nodeId: string): { rowStart: number; rowEnd: number; column: number } => {
    const node = graph.nodes.get(nodeId)!;

    if (!node.producer) {
      const existing = rowOfIngredient.get(nodeId);
      if (existing !== undefined) {
        if (!sharedComponents.includes(nodeId)) sharedComponents.push(nodeId);
        const index = pushRow({
          kind: 'back-reference',
          nodeId,
          label: node.name,
          refersToRow: existing,
          note: 'used again',
        });
        return { rowStart: index, rowEnd: index, column: 0 };
      }
      const ingredient = graph.ingredients.get(nodeId);
      const index = pushRow({
        kind: 'ingredient',
        nodeId,
        label: node.name,
        quantity: ingredient?.quantity ? formatQuantity(ingredient.quantity) : undefined,
        allergens: ingredient && ingredient.allergens.length > 0 ? ingredient.allergens : undefined,
        state: node.state,
        note: ingredient?.notes,
      });
      rowOfIngredient.set(nodeId, index);
      return { rowStart: index, rowEnd: index, column: 0 };
    }

    const drawn = spanOfOperation.get(node.producer);
    if (drawn) {
      if (!sharedComponents.includes(nodeId)) sharedComponents.push(nodeId);
      const index = pushRow({
        kind: 'back-reference',
        nodeId,
        label: node.name,
        state: node.state,
        refersToRow: drawn.rowStart,
        note: 'produced above',
      });
      return { rowStart: index, rowEnd: index, column: 0 };
    }

    const op = graph.operations.get(node.producer)!;
    const children = op.inputs.map(visit);

    // An operation with no inputs still needs somewhere to sit.
    const span =
      children.length > 0
        ? {
            rowStart: Math.min(...children.map((c) => c.rowStart)),
            rowEnd: Math.max(...children.map((c) => c.rowEnd)),
            column: Math.max(...children.map((c) => c.column)) + 1,
          }
        : (() => {
            const index = pushRow({ kind: 'operation-source', nodeId: '', label: op.action });
            return { rowStart: index, rowEnd: index, column: 1 };
          })();

    spanOfOperation.set(op.id, span);
    cells.push({
      operationId: op.id,
      column: span.column,
      rowStart: span.rowStart,
      rowSpan: span.rowEnd - span.rowStart + 1,
      label: op.action,
      outputs: op.outputs.map((o) => ({ id: o.id, name: o.name, state: o.state })),
      detail: describe(op),
    });
    return span;
  };

  for (const root of roots) visit(root);

  // Ingredients that reach the plate untouched are not orphans; the plan says
  // where they go. Drawn after the tree, with no cell, because no operation
  // ever spans them.
  const served = new Set(plan.serviceState.components.map((c) => c.componentId));
  for (const ingredient of plan.ingredients) {
    if (rowOfIngredient.has(ingredient.id)) continue;
    if (!served.has(ingredient.id)) continue;
    const index = pushRow({
      kind: 'served-directly',
      nodeId: ingredient.id,
      label: ingredient.name,
      quantity: ingredient.quantity ? formatQuantity(ingredient.quantity) : undefined,
      allergens: ingredient.allergens.length > 0 ? ingredient.allergens : undefined,
      state: ingredient.startingState,
      note: 'plated as it is',
    });
    rowOfIngredient.set(ingredient.id, index);
  }

  const orphanRows: number[] = [];
  for (const ingredient of plan.ingredients) {
    if (rowOfIngredient.has(ingredient.id)) continue;
    const index = pushRow({
      kind: 'orphan',
      nodeId: ingredient.id,
      label: ingredient.name,
      quantity: ingredient.quantity ? formatQuantity(ingredient.quantity) : undefined,
      allergens: ingredient.allergens.length > 0 ? ingredient.allergens : undefined,
      state: ingredient.startingState,
      note: 'declared and never used',
    });
    rowOfIngredient.set(ingredient.id, index);
    orphanRows.push(index);
  }

  const columnCount = cells.reduce((max, cell) => Math.max(max, cell.column), 0) + 1;

  return {
    renderable: true,
    title: plan.title,
    servings: plan.servings,
    locale: plan.locale,
    serviceAtMinute: plan.serviceAtMinute,
    serviceClock: plan.serviceClock,
    columnCount,
    rows,
    cells,
    sharedComponents,
    orphanRows,
    steps: buildSteps(plan, graph),
  };
}

/**
 * Terminal operations, service order first.
 *
 * "Service order first" only affects which dish is drawn at the top of the
 * table; it is a reading convenience, and it is deterministic, which matters
 * more — two runs of the same plan must produce the same table or a stored
 * render stops being reproducible.
 */
function findRoots(plan: KitchenPlan, graph: PlanGraph): string[] {
  const terminals: string[] = [];
  for (const op of plan.operations) {
    for (const out of op.outputs) {
      if ((graph.consumersOf.get(out.id) ?? []).length === 0) terminals.push(out.id);
    }
  }
  const serviceOrder = plan.serviceState.components.map((c) => c.componentId);
  const rank = (id: string) => {
    const i = serviceOrder.indexOf(id);
    return i === -1 ? serviceOrder.length + terminals.indexOf(id) : i;
  };
  return [...terminals].sort((a, b) => rank(a) - rank(b));
}

/**
 * The accessible linearisation: the same operations in a valid execution order.
 *
 * A screen-reader user gets the graph as a sequence rather than as a grid of
 * merged cells. The topological order is the graph's own, so the step list can
 * never disagree with the table.
 */
function buildSteps(plan: KitchenPlan, graph: PlanGraph): TrnStep[] {
  const order = graph.order ?? plan.operations.map((o) => o.id);
  const nameOf = (id: string) => graph.nodes.get(id)?.name ?? id;
  return order.map((id, i) => {
    const op = graph.operations.get(id)!;
    const detail = describe(op);
    const parts = [
      `${op.action} ${op.inputs.map(nameOf).join(', ') || '(nothing declared)'}`,
      detail.equipment && detail.equipment.length > 0 ? `using ${detail.equipment.join(', ')}` : undefined,
      detail.temperature,
      detail.duration,
      detail.sensoryTarget ? `until ${detail.sensoryTarget}` : undefined,
      `→ ${op.outputs.map((o) => `${o.name} (${o.state})`).join(', ')}`,
    ].filter((p): p is string => Boolean(p));
    return {
      order: i + 1,
      operationId: id,
      summary: parts.join(', '),
      inputs: op.inputs,
      outputs: op.outputs.map((o) => o.id),
      startAtMinute: op.startAtMinute,
    };
  });
}

function describe(op: PlanOperation): TrnCellDetail {
  return {
    duration: op.duration ? formatDuration(op.duration.minMinutes, op.duration.maxMinutes) : undefined,
    temperature: op.temperature ? `${trim(op.temperature.value)}°${op.temperature.unit} ${op.temperature.kind}` : undefined,
    equipment: op.equipment.length > 0 ? op.equipment : undefined,
    sensoryTarget: op.sensoryTarget,
    attention: op.attention,
    startAtMinute: op.startAtMinute,
  };
}

export function formatDuration(minMinutes: number, maxMinutes: number): string {
  return minMinutes === maxMinutes ? `${trim(minMinutes)} min` : `${trim(minMinutes)}–${trim(maxMinutes)} min`;
}

export function formatQuantity(quantity: { amount: number; unit: string; approximate?: boolean }): string {
  const body = `${trim(quantity.amount)} ${quantity.unit}`.trim();
  // "About" rather than "~": the renderer output is read aloud as often as it
  // is looked at, and a tilde is not a word.
  return quantity.approximate ? `about ${body}` : body;
}

/** Drop float noise without pretending to more precision than was given. */
function trim(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}
