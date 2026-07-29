import { scoreFill } from '@/lib/format';

export function ScoreBar({ score, color }: { score: number; color?: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="h-2 w-full max-w-40 bg-paper-tint">
        <div
          className="h-2"
          style={{ width: `${score}%`, background: color ?? scoreFill(score) }}
        />
      </div>
      <span className="tabular w-12 text-right text-sm">{score.toFixed(1)}</span>
    </div>
  );
}
