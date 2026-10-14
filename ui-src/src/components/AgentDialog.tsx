import { useEffect } from 'react';
import { agentApiInstructions } from '../lib';
import { CopyButton } from './CopyButton';

const MCP_JSON = `{
  "mcpServers": {
    "netbridge": { "command": "npx", "args": ["-y", "netbridge", "mcp"] }
  }
}`;

const MCP_TOOLS = [
  'list_requests',
  'list_hosts',
  'get_request',
  'get_call_tree',
  'resend_request',
  'clear_requests',
  'list_mocks / set_mock / delete_mock',
];

/** One copyable command or config block. */
function Snippet({ text }: { text: string }) {
  return (
    <div className="snippet">
      <pre>{text}</pre>
      <CopyButton text={text} />
    </div>
  );
}

/**
 * How to hand the capture to an AI agent: the MCP server, which the agent
 * drives itself, or a briefing on the HTTP API to paste into its chat.
 */
export function AgentDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const origin = window.location.origin;
  const port = window.location.port;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is a mouse shortcut; Esc and close work too
    <div
      className="resend-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal agent-modal" role="dialog" aria-label="connect an AI agent">
        <h3>connect an AI agent</h3>
        <p className="agent-lead">
          Give a coding agent (Claude Code, Cursor, …) the traffic captured here, so it can check what your server
          sent and received while it debugs.
        </p>

        <h4>MCP server: the agent reads the capture itself</h4>
        <div className="modal-label">Claude Code</div>
        <Snippet text="claude mcp add netbridge -- npx -y netbridge mcp" />
        <div className="modal-label">other clients (Cursor, Claude Desktop, …): add to the MCP config</div>
        <Snippet text={MCP_JSON} />
        <div className="agent-note">
          tools: {MCP_TOOLS.join(', ')}. It finds the running netbridge on ports 4499–4510; with several running, pin
          this one with <code>NETBRIDGE_PORT={port}</code> in its environment.
        </div>

        <h4>HTTP API: paste a briefing into the chat</h4>
        <div className="agent-note">
          For agents without MCP, or scripts: a short text with the endpoints of this collector, a curl example and
          how to read entries. After that the agent can fetch your traffic on its own.
        </div>
        <div className="modal-actions agent-api">
          <a href={`${origin}/api/requests`} target="_blank" rel="noreferrer">
            open /api/requests ↗
          </a>
          <CopyButton className="modal-send" label="copy briefing" text={() => agentApiInstructions(origin)} />
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            close
          </button>
        </div>
      </div>
    </div>
  );
}
