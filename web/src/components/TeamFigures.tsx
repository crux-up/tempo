import type { ReactNode } from 'react';
import { FACT } from '../facts';
import { count, hours, share } from '../format';
import type { ReviewFlowReport } from '../types';
import { Num, Placeholder } from './Num';

type Cell = { label: string; value: (report: ReviewFlowReport) => ReactNode; sub: (report: ReviewFlowReport) => ReactNode };

const plain = (n: number, unit = '') => ({ value: count(n), unit });

const CELLS: Cell[] = [
  {
    label: 'Median wait for first review',
    value: ({ team }) => <Num figure={hours(team.timeToFirstReview.medianHours)} fact={FACT.firstReviewMedian} />,
    sub: ({ team }) => (
      <>
        p90 <Num figure={hours(team.timeToFirstReview.p90Hours)} fact={FACT.firstReviewP90} /> · n{' '}
        <Num figure={plain(team.timeToFirstReview.sampleSize)} fact={FACT.firstReviewSample} />
      </>
    ),
  },
  {
    label: 'Open, awaiting first review',
    value: ({ team }) => <Num figure={plain(team.awaitingFirstReview.count, 'PRs')} fact={FACT.awaitingCount} />,
    sub: ({ team }) => (
      <>
        median age <Num figure={hours(team.awaitingFirstReview.medianAgeHours)} fact={FACT.awaitingAge} />
      </>
    ),
  },
  {
    label: 'Median time to merge',
    value: ({ team }) => <Num figure={hours(team.timeToMerge.medianHours)} fact={FACT.mergeMedian} />,
    sub: ({ team }) => (
      <>
        p90 <Num figure={hours(team.timeToMerge.p90Hours)} fact={FACT.mergeP90} /> · n{' '}
        <Num figure={plain(team.timeToMerge.sampleSize)} fact={FACT.mergeSample} />
      </>
    ),
  },
  {
    label: 'Merged without review',
    value: ({ team }) => <Num figure={share(team.mergedWithoutReview.share)} fact={FACT.unreviewedShare} />,
    sub: ({ team }) => (
      <>
        <Num figure={plain(team.mergedWithoutReview.count)} fact={FACT.unreviewedCount} /> of{' '}
        <Num figure={plain(team.prsMerged)} /> merged
      </>
    ),
  },
  {
    label: "Top reviewer's share",
    value: ({ team }) => (
      <Num figure={share(team.reviewConcentration.topReviewerShare)} fact={FACT.topReviewerShare} />
    ),
    sub: ({ team }) =>
      team.reviewConcentration.topReviewer ? (
        <span data-fact={FACT.topReviewer}>{team.reviewConcentration.topReviewer}</span>
      ) : (
        'no reviews yet'
      ),
  },
  {
    label: 'Half of reviews come from',
    value: ({ team }) => {
      const n = team.reviewConcentration.reviewersFor50Pct;
      return <Num figure={plain(n, n === 1 ? 'person' : 'people')} fact={FACT.reviewersForHalf} />;
    },
    sub: ({ people }) => (
      <>
        of <Num figure={plain(people.filter((p) => !p.unlinked).length)} fact={FACT.peopleCount} /> active
      </>
    ),
  },
];

/** Team figures as type: a label over the value, sample sizes beside the medians. No tiles. */
export function TeamFigures({ report }: { report: ReviewFlowReport | null }) {
  return (
    <dl className="figures">
      {CELLS.map((cell) => (
        <div className="figure" key={cell.label}>
          <dt className="figure-label">{cell.label}</dt>
          <dd className="figure-value">{report ? cell.value(report) : <Placeholder size="figure" />}</dd>
          <dd className="figure-sub">{report ? cell.sub(report) : <Placeholder />}</dd>
        </div>
      ))}
    </dl>
  );
}
