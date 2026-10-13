import type { CapturedRequest } from '../types';
import { CopyButton } from './CopyButton';

interface Operation {
  query?: string;
  variables?: unknown;
}

/** The operations a GraphQL call sent, with their query text and variables. */
function operations(r: CapturedRequest): Operation[] {
  try {
    if (r.method === 'GET') {
      const p = new URL(r.url).searchParams;
      const vars = p.get('variables');
      return [{ query: p.get('query') ?? undefined, variables: vars ? JSON.parse(vars) : undefined }];
    }
    const parsed = JSON.parse(r.reqBody ?? '') as Operation | Operation[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** Request tab: each operation's name, variables and query, apart from the JSON around them. */
export function GraphqlRequest({ r }: { r: CapturedRequest }) {
  if (!r.gql) return null;
  const ops = operations(r);
  return (
    <div className="section">
      <div className="sec-head">
        <h3>graphql</h3>
      </div>
      {ops.map((op, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: operations of one call never reorder
        <div key={i} className="gql-op">
          <div className="gql-name">{r.gql?.[i] ?? 'operation'}</div>
          {op.variables !== undefined && (
            <>
              <div className="sec-head">
                <span className="modal-label">variables</span>
                <CopyButton text={JSON.stringify(op.variables, null, 2)} />
              </div>
              <pre>{JSON.stringify(op.variables, null, 2)}</pre>
            </>
          )}
          {typeof op.query === 'string' && (
            <>
              <div className="sec-head">
                <span className="modal-label">query</span>
                <CopyButton text={op.query} />
              </div>
              <pre>{op.query.trim()}</pre>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/** Response tab: the errors a 200 can hide. */
export function GraphqlErrors({ r }: { r: CapturedRequest }) {
  if (!r.gqlErrors) return null;
  return (
    <div className="section">
      <div className="sec-head">
        <h3>graphql errors</h3>
      </div>
      <ul className="gql-errors">
        {r.gqlErrors.map((m, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: errors of one response never reorder
          <li key={i}>{m}</li>
        ))}
      </ul>
    </div>
  );
}
