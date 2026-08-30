export interface Verification {
  available: boolean;
  expected: number | null;
  capturedAgent: number;
  capturedBackground: number;
  missing: number;
  extra?: number;
  subAgents: number | null;
}

export interface SessionRow {
  session_id: string;
  status: string | null;
  started_at: string | null;
  ended_at: string | null;
  cwd: string | null;
  context_count: number;
  turn_count: number;
  aic: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  summary: string | null;
  repository: string | null;
  branch: string | null;
  verification?: Verification;
}

export interface ContextRow {
  context_id: number;
  session_id: string;
  label: string | null;
  kind?: 'main' | 'sub' | 'background';
  interaction_type?: string | null;
  agent_id: string | null;
  first_seen_at: string | null;
  turn_count: number;
}

export interface TurnLite {
  id: number;
  turn_index: number;
  model: string | null;
  finish_reason: string | null;
  captured_at: string | null;
  duration_ms: number | null;
  status_code: number | null;
  canonical_prompt_text: string | null;
  usage_json: string | null;
  request_payload_bytes: number | null;
  common_prefix_bytes: number | null;
}

export interface TurnFull extends TurnLite {
  session_id: string;
  context_id: number;
  host: string | null;
  path: string | null;
  method: string | null;
  stream: number | null;
  request_headers_json: string | null;
  params_json: string | null;
  messages_json: string | null;
  tools_json: string | null;
  request_payload_text: string | null;
  response_text: string | null;
  tool_calls_json: string | null;
  raw_response_json: string | null;
}
