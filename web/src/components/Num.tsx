import type { Figure } from '../format';

type NumProps = { figure: Figure; fact?: string; className?: string };

/** A number with its unit as a smaller grey suffix; a missing value is a grey dash. */
export function Num({ figure, fact, className }: NumProps) {
  if (!figure) {
    return (
      <span className={`dash ${className ?? ''}`} data-fact={fact} aria-label="no data">
        —
      </span>
    );
  }
  return (
    <span className={`num ${className ?? ''}`} data-fact={fact}>
      {figure.value}
      {figure.unit && <span className="unit">{figure.unit === '%' ? '%' : ` ${figure.unit}`}</span>}
    </span>
  );
}

/** A flat grey bar standing in for a value while it loads, at the value's size. */
export function Placeholder({ size = 'text' }: { size?: 'text' | 'figure' | 'wide' }) {
  return <span className={`placeholder placeholder-${size}`} aria-hidden="true" />;
}
