const PR_PAGE_SIZE = 50;
const REVIEW_PAGE_SIZE = 50;
const COMMIT_PAGE_SIZE = 100;

const REVIEW_FIELDS = `
  pageInfo { hasNextPage endCursor }
  nodes {
    id
    state
    submittedAt
    author { __typename login }
    comments { totalCount }
  }`;

const RATE_LIMIT = 'rateLimit { remaining resetAt }';

export const REPOSITORY_QUERY = `
query Repository($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    isPrivate
    defaultBranchRef { name }
  }
  ${RATE_LIMIT}
}`;

export const PULL_REQUESTS_QUERY = `
query PullRequests($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(
      first: ${PR_PAGE_SIZE}
      after: $cursor
      orderBy: { field: UPDATED_AT, direction: DESC }
      states: [OPEN, CLOSED, MERGED]
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        number
        createdAt
        updatedAt
        mergedAt
        closedAt
        additions
        deletions
        author { __typename login }
        reviews(first: ${REVIEW_PAGE_SIZE}) {${REVIEW_FIELDS}
        }
      }
    }
  }
  ${RATE_LIMIT}
}`;

export const REVIEWS_QUERY = `
query Reviews($prId: ID!, $cursor: String) {
  node(id: $prId) {
    ... on PullRequest {
      reviews(first: ${REVIEW_PAGE_SIZE}, after: $cursor) {${REVIEW_FIELDS}
      }
    }
  }
  ${RATE_LIMIT}
}`;

export const COMMITS_QUERY = `
query Commits($owner: String!, $name: String!, $branch: String!, $cursor: String, $since: GitTimestamp, $until: GitTimestamp) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $branch) {
      target {
        ... on Commit {
          history(first: ${COMMIT_PAGE_SIZE}, after: $cursor, since: $since, until: $until) {
            pageInfo { hasNextPage endCursor }
            nodes {
              oid
              committedDate
              author { name user { login } }
            }
          }
        }
      }
    }
  }
  ${RATE_LIMIT}
}`;
