export interface CapturedRequest {
  id: string;
  seq: number;
  ts: number;
  pid?: number;
  source?: 'fetch' | 'http';
  method: string;
  url: string;
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
