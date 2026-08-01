import Link from 'next/link';
import type { ReactNode } from 'react';
import { CONSTRUCTS, V21_RECORD } from '@/lib/research';

type StatusTone = 'observed' | 'exploratory' | 'preliminary' | 'proposed' | 'archived';

const STATUS_STYLES: Record<StatusTone, string> = {
  observed: 'border-herb text-herb',
  exploratory: 'border-saffron-ink text-saffron-ink',
  preliminary: 'border-paprika-ink text-paprika-ink',
  proposed: 'border-hairline text-ink-soft',
  archived: 'border-charcoal text-charcoal',
};

export function ResearchStatusChip({
  children,
  tone,
}: {
  children: ReactNode;
  tone: StatusTone;
}) {
  return (
    <span
      className={`inline-flex items-center border px-2 py-1 font-mono text-[0.68rem] uppercase tracking-[0.12em] ${STATUS_STYLES[tone]}`}
    >
      {children}
    </span>
  );
}
export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="underline decoration-hairline underline-offset-4 transition-colors hover:text-paprika"
    >
      {children}
    </Link>
  );
}

export function PublicationHeader({
  title,
  subtitle,
  statuses,
  meta,
  actions,
}: {
  title: string;
  subtitle: string;
  statuses: Array<{ label: string; tone: StatusTone }>;
  meta: string;
  actions?: Array<{ label: string; href: string }>;
}) {
  return (
    <header className="border-b-2 border-ink pb-10 pt-14 sm:pt-20">
      <div className="flex flex-wrap gap-2">
        {statuses.map((status) => (
          <ResearchStatusChip key={status.label} tone={status.tone}>
            {status.label}
          </ResearchStatusChip>
        ))}
      </div>
      <h1
        className="mt-7 max-w-5xl font-display font-semibold tracking-tight"
        style={{ fontSize: 'clamp(2.4rem, 6vw, 5.4rem)', letterSpacing: '-0.035em', lineHeight: 0.98 }}
      >
        {title}
      </h1>
      <p className="mt-7 max-w-3xl font-display text-2xl leading-snug text-ink-soft sm:text-3xl">
        {subtitle}
      </p>
      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-hairline pt-4">
        <p className="font-mono text-xs text-ink-soft">{meta}</p>
        {actions?.map((action) => (
          <TextLink key={action.href} href={action.href}>
            {action.label}
          </TextLink>
        ))}
      </div>
    </header>
  );
}

export function ArchivedResultNotice() {
  return (
    <aside className="border-y-2 border-paprika bg-paper-tint px-5 py-6 sm:px-7" aria-label="Study status">
      <div className="flex flex-wrap items-center gap-3">
        <ResearchStatusChip tone="archived">Archived</ResearchStatusChip>
        <ResearchStatusChip tone="preliminary">Preliminary study</ResearchStatusChip>
        <span className="font-mono text-xs text-ink-soft">{V21_RECORD.runId}</span>
      </div>
      <h2 className="mt-5 font-display text-2xl font-semibold">v2.1 did not identify one best AI cook.</h2>
      <p className="mt-3 max-w-4xl leading-relaxed text-ink-soft">
        The response corpus is complete and preserved. A retrospective audit found that saturated
        items and scoring defects made the fine-grained ordering of leading models more precise
        than the evidence warranted. The original scores remain visible as a historical record;
        no corrected winner is being claimed.
      </p>
      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <TextLink href="/research/v2-1-autopsy">Read what changed</TextLink>
        <TextLink href="/results/2026-07-v2-1">View the archived result</TextLink>
      </div>
    </aside>
  );
}

export function ConstructTable({ compact = false }: { compact?: boolean }) {
  return (
    <div className="border-x border-t border-hairline" role="table" aria-label="Culinary intelligence construct map">
      <div
        className="hidden grid-cols-[1.1fr_1.25fr_1.45fr] border-b border-ink bg-paper-tint px-4 py-3 font-mono text-[0.68rem] uppercase tracking-[0.12em] text-ink-soft sm:grid"
        role="row"
      >
        <span role="columnheader">Constraint</span>
        <span role="columnheader">Operation</span>
        <span role="columnheader">Evidence sought</span>
      </div>
      {CONSTRUCTS.slice(0, compact ? 3 : CONSTRUCTS.length).map((construct, index) => (
        <div
          key={construct.name}
          className="grid border-b border-hairline px-4 py-5 sm:grid-cols-[1.1fr_1.25fr_1.45fr] sm:gap-6"
          role="row"
        >
          <div role="cell">
            <p className="font-mono text-[0.68rem] uppercase tracking-[0.12em] text-paprika">
              {String(index + 1).padStart(2, '0')} · {construct.name}
            </p>
            <p className="mt-2 text-sm leading-relaxed">{construct.constraint}</p>
          </div>
          <div className="mt-4 border-l border-hairline pl-4 sm:mt-0" role="cell">
            <p className="font-mono text-[0.65rem] uppercase tracking-wider text-ink-soft sm:hidden">Operation</p>
            <p className="mt-1 text-sm leading-relaxed sm:mt-0">{construct.operation}</p>
          </div>
          <div className="mt-4 border-l border-hairline pl-4 sm:mt-0" role="cell">
            <p className="font-mono text-[0.65rem] uppercase tracking-wider text-ink-soft sm:hidden">Evidence sought</p>
            <p className="mt-1 text-sm leading-relaxed text-ink-soft sm:mt-0">{construct.claim}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function FactStrip({ facts }: { facts: Array<{ value: string; label: string }> }) {
  return (
    <dl className="grid border-x border-t border-hairline sm:grid-cols-2 lg:grid-cols-4">
      {facts.map((fact) => (
        <div key={fact.label} className="border-b border-hairline px-5 py-5 lg:border-r last:lg:border-r-0">
          <dd className="font-mono text-2xl tabular-nums sm:text-3xl">{fact.value}</dd>
          <dt className="mt-2 text-sm leading-snug text-ink-soft">{fact.label}</dt>
        </div>
      ))}
    </dl>
  );
}

export function EvidenceNote({ label, children }: { label: string; children: ReactNode }) {
  return (
    <aside className="border-l-2 border-herb pl-4 text-sm leading-relaxed text-ink-soft">
      <p className="font-mono text-[0.68rem] uppercase tracking-[0.12em] text-herb">{label}</p>
      <div className="mt-2">{children}</div>
    </aside>
  );
}
