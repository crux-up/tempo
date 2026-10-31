/** Hour steps that read naturally on a duration axis: whole hours, then quarter, half and whole days, then weeks. */
const HOUR_STEPS = [1, 2, 3, 6, 12, 24, 48, 72, 168, 336, 720];

/**
 * Round ticks from zero whose top sits above the largest value, at most `maxTicks` intervals.
 * An all-empty axis still gets a scale, so the frame and its zero line are drawn.
 */
export function hourTicks(max: number, maxTicks = 4): number[] {
  const step = HOUR_STEPS.find((s) => max / s < maxTicks) ?? HOUR_STEPS[HOUR_STEPS.length - 1]!;
  let top = Math.ceil(max / step) * step;
  if (top <= max) top += step;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return ticks;
}

/** Every k-th index so labels keep one step and fit the width; the first label always shows. */
export function labelEvery(count: number, width: number, labelWidth: number): number {
  const fit = Math.max(1, Math.floor(width / labelWidth));
  return Math.max(1, Math.ceil(count / fit));
}
