export interface CapturedRequest {
  id: string;
  seq: number;
  ts: number;
  pid?: number;
  source?: 'fetch' | 'http' | 'replay';
  method: string;
  url: string;
  /** For replay entries: the id of the original captured request. */
  replayOf?: string;
  state: 'pending' | 'done' | 'error';
  reqHeaders?: Record<string, string>;
  reqBody?: string;
  reqBodyEncoding?: 'utf8' | 'base64';
  reqBodyTruncated?: boolean;
  status?: number;
  statusText?: string;
  resHeaders?: Record<string, string>;
  resBody?: string;
  resBodyEncoding?: 'utf8' | 'base64';
  resBodyTruncated?: boolean;
  durationMs?: number;
  error?: string;
}

export type WireEvent = Partial<CapturedRequest> & {
  id: string;
  phase?: 'start' | 'end' | 'error';
};

/** GET /api/config: CLI options that shape the UI's starting view. */
export interface ViewConfig {
  /** `--exclude` patterns to seed the filter box with. */
  exclude: string[];
  /** When the collector started; tells netbridge runs apart. */
  startedAt: number;
}
