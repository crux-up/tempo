import { ordinal } from '@api/metrics/stats.js';
import { useEffect, useState } from 'react';
import { personFact, personRow } from '../facts';
import { count, share } from '../format';
import type { Person } from '../types';
import { Num, Placeholder } from './Num';

const VISIBLE_ROWS = 10;

type SortKey = 'prsReviewed' | 'reviewShare' | 'balance' | 'codeShare' | 'prsMerged' | 'approvals' | 'reviewComments' | 'commits';

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: 'prsReviewed', label: 'PRs reviewed', numeric: true },
  { key: 'reviewShare', label: 'Review share', numeric: true },
  { key: 'balance', label: 'Review vs code', numeric: false },
  { key: 'codeShare', label: 'Code share', numeric: true },
  { key: 'prsMerged', label: 'PRs merged', numeric: true },
  { key: 'approvals', label: 'Approved', numeric: true },
  { key: 'reviewComments', label: 'Comments', numeric: true },
  { key: 'commits', label: 'Commits', numeric: true },
];

const sortValue = (p: Person, key: SortKey) => (key === 'balance' ? p.reviewShare - p.codeShare : p[key]);
/** The chosen column first, then the API's own tie-break: PRs reviewed, PRs merged, login in code-unit order. */
const sortedPeople = (people: Person[], key: SortKey) =>
  [...people].sort(
    (a, b) =>
      sortValue(b, key) - sortValue(a, key) ||
      b.prsReviewed - a.prsReviewed ||
      b.prsMerged - a.prsMerged ||
      ordinal(a.login, b.login),
  );
const rowKey = (p: Person) => `${p.login}\u0000${p.unlinked ? 'git' : 'gh'}`;
const isBot = (login: string) => login.endsWith('[bot]');

/** Review share to the left of the axis in the data hue, code share to the right in grey, on one scale for all rows. */
function Balance({ person, scale }: { person: Person; scale: number }) {
  const half = 100;
  const left = scale ? (person.reviewShare / scale) * half : 0;
  const right = scale ? (person.codeShare / scale) * half : 0;
  return (
    <svg className="balance" viewBox="0 0 200 12" preserveAspectRatio="none" aria-hidden="true">
      <rect x={half - left} y="1" width={left} height="10" className="balance-review" />
      <rect x={half} y="1" width={right} height="10" className="balance-code" />
      <line x1={half} x2={half} y1="0" y2="12" className="balance-axis" />
    </svg>
  );
}

function Identity({ person }: { person: Person }) {
  if (person.unlinked) {
    return (
      <span className="identity">
        <span className="identity-name">{person.login}</span>
        <span className="tag" title="A git author name with no linked GitHub account">
          git name
        </span>
      </span>
    );
  }
  return (
    <span className="identity">
      <a className="identity-name" href={`https://github.com/${encodeURIComponent(person.login)}`} rel="noreferrer" target="_blank">
        {person.login}
      </a>
      {isBot(person.login) && <span className="tag">bot</span>}
    </span>
  );
}

type PeopleTableProps = { people: Person[] | null; revealLogin: string | null };

/** Who reviews and who ships, one row per person. Linked accounts and git names stay apart even when they match. */
export function PeopleTable({ people, revealLogin }: PeopleTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('prsReviewed');
  const [expanded, setExpanded] = useState(false);
  const sorted = people ? sortedPeople(people, sortKey) : [];
  const revealIndex = revealLogin === null ? -1 : sorted.findIndex((p) => !p.unlinked && p.login === revealLogin);
  const revealHidden = revealIndex >= VISIBLE_ROWS;

  // A cited person past the cap expands the table; it stays expanded after the reveal ends, with its toggle shown.
  useEffect(() => {
    if (revealHidden) setExpanded(true);
  }, [revealHidden]);

  if (people && people.length === 0) {
    return <p className="empty">Nobody reviewed, merged or committed in this window.</p>;
  }

  const rows = expanded || revealHidden ? sorted : sorted.slice(0, VISIBLE_ROWS);
  const scale = Math.max(0, ...sorted.map((p) => Math.max(p.reviewShare, p.codeShare)));

  return (
    <div className="table-frame">
      <table className="people">
        <caption className="sr-only">People by review and code activity, sorted by {COLUMNS.find((c) => c.key === sortKey)?.label}</caption>
        <thead>
          <tr>
            <th scope="col" className="col-person">
              Person
            </th>
            {COLUMNS.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={column.numeric ? 'num' : 'col-balance'}
                aria-sort={sortKey === column.key ? 'descending' : 'none'}
              >
                <button type="button" className="sort" onClick={() => setSortKey(column.key)}>
                  {column.label}
                  {sortKey === column.key && <span aria-hidden="true"> ↓</span>}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {people === null
            ? Array.from({ length: 6 }, (_, i) => (
                <tr key={i}>
                  <td className="col-person">
                    <Placeholder size="wide" />
                  </td>
                  {COLUMNS.map((c) => (
                    <td key={c.key} className={c.numeric ? 'num' : 'col-balance'}>
                      <Placeholder />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((p) => {
                const fact = (field: string) => (p.unlinked ? undefined : personFact(p.login, field));
                return (
                  <tr key={rowKey(p)} data-fact-row={p.unlinked ? undefined : personRow(p.login)}>
                    <th scope="row" className="col-person">
                      <Identity person={p} />
                    </th>
                    <td className="num">
                      <Num figure={{ value: count(p.prsReviewed), unit: '' }} fact={fact('prsReviewed')} />
                      <span className="cell-sub">
                        <Num figure={{ value: count(p.reviewsSubmitted), unit: '' }} fact={fact('reviewsSubmitted')} /> reviews
                      </span>
                    </td>
                    <td className="num">
                      <Num figure={share(p.reviewShare)} fact={fact('reviewShare')} />
                    </td>
                    <td className="col-balance">
                      <Balance person={p} scale={scale} />
                    </td>
                    <td className="num">
                      <Num figure={share(p.codeShare)} fact={fact('codeShare')} />
                    </td>
                    <td className="num">
                      <Num figure={{ value: count(p.prsMerged), unit: '' }} fact={fact('prsMerged')} />
                      <span className="cell-sub">
                        <Num figure={{ value: count(p.prsOpened), unit: '' }} fact={fact('prsOpened')} /> opened
                      </span>
                    </td>
                    <td className="num">
                      <Num figure={{ value: count(p.approvals), unit: '' }} fact={fact('approvals')} />
                      <span className="cell-sub">
                        <Num figure={{ value: count(p.changesRequested), unit: '' }} fact={fact('changesRequested')} /> changes
                      </span>
                    </td>
                    <td className="num">
                      <Num figure={{ value: count(p.reviewComments), unit: '' }} fact={fact('reviewComments')} />
                    </td>
                    <td className="num">
                      <Num figure={{ value: count(p.commits), unit: '' }} fact={fact('commits')} />
                    </td>
                  </tr>
                );
              })}
        </tbody>
      </table>
      {people && sorted.length > VISIBLE_ROWS && (expanded || !revealHidden) && (
        <button type="button" className="text-button table-more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? `Show the top ${VISIBLE_ROWS}` : `Show all ${count(sorted.length)} people`}
        </button>
      )}
    </div>
  );
}

