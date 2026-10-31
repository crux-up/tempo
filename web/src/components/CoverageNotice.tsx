import { FACT } from '../facts';
import { dateTime, windowEnd, windowStart } from '../format';

type Range = { from: string; to: string };
type CoverageNoticeProps = { coverage: Range & { partial: boolean }; window: Range };

/** Says where the synced data stops short of the window: at its start (backfill) and/or its end (a refresh cut short). */
export function CoverageNotice({ coverage, window }: CoverageNoticeProps) {
  if (!coverage.partial) return null;
  const missingStart = coverage.from > window.from;
  const missingEnd = coverage.to < window.to;
  return (
    <p className="notice" data-fact={FACT.coveragePartial}>
      Partial data:{' '}
      {missingStart && (
        <>
          synced history starts on <strong data-fact={FACT.coverageFrom}>{dateTime(coverage.from)}</strong>, after the
          window&rsquo;s start on {windowStart(window.from)}. The sync budget stopped the backfill, so every number below
          leaves out the weeks before that date.
        </>
      )}
      {missingStart && missingEnd && ' '}
      {missingEnd && (
        <>
          {missingStart ? 'Synced' : 'synced'} data ends at <strong data-fact={FACT.coverageTo}>{dateTime(coverage.to)}</strong>,
          before the window&rsquo;s end on {windowEnd(window.to)}. A refresh stopped on the sync budget, so every number
          below leaves out what happened after that time.
        </>
      )}
      {!missingStart && !missingEnd && 'the synced data does not cover the whole window.'}
    </p>
  );
}
