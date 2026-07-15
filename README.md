# MCP Center

MCP Center is a local MCP gateway with a built-in Web UI. It manages multiple child MCP servers, keeps their configuration in one place, and exposes a single Streamable HTTP MCP endpoint for your MCP client to connect to.

MCP Center can aggregate capabilities from:

- HTTP MCP servers
- local stdio MCP servers
- WebSocket bridge clients that connect back to MCP Center

It currently republishes these MCP capabilities through the main endpoint:

- tools
- resources
- resource templates
- prompts

> WebSocket bridge clients currently contribute tools only. Resources, resource templates, and prompts from WebSocket bridge clients are not exposed.

To avoid collisions, every exposed capability is prefixed with the child server name:

- tool: `exa_web_search_exa`
- resource: `filesystem_file:///tmp/a.txt`
- prompt: `docs_summarize`
- WebSocket bridge tool: `my_agent_search`

## Usage Model

Run MCP Center directly with `npx`, then connect your MCP client to the HTTP endpoint it starts:

1. Start `mcp-center` with `npx @sunwu51/mcp-center`
2. Open the Web UI to add or edit HTTP/stdio child MCP servers
3. Optionally let remote/local agents connect as WebSocket bridge clients
4. Point your MCP client at `http://localhost:3000/mcp`

## Quick Start

### 1. Start MCP Center

```bash
npx @sunwu51/mcp-center
```

This command executes the package's CLI entry directly. No global install is required.

By default it uses `~/.mcp-center/mcp.json`. If the file does not exist, it will be created automatically as:

```json
{
  "servers": []
}
```

You can also pass a custom config path:

```bash
npx @sunwu51/mcp-center --config /path/to/mcp.json
```

Or:

```bash
npx @sunwu51/mcp-center /path/to/mcp.json
```

### 2. Open the Web UI

Open:

```text
http://localhost:3000/ui
```

From the UI you can:

- add HTTP or stdio child MCP servers
- edit server config
- enable or disable a configured server
- delete a configured server
- probe a server before saving to inspect tools/resources/templates/prompts
- selectively enable only part of a configured server's capabilities
- view connection status and loaded capabilities
- view connected WebSocket bridge clients as read-only, auto-registered servers

### 3. Connect your MCP client to MCP Center

Use this endpoint:

```text
http://localhost:3000/mcp
```

Your MCP client must support Streamable HTTP transport.

## WebSocket Bridge

MCP Center also starts a WebSocket bridge server on the same port:

```text
ws://localhost:3000/ws/:serverName
```

A WebSocket bridge client connects to this URL and behaves like a lightweight MCP server over a JSON-RPC WebSocket connection. MCP Center performs an MCP-style handshake, lists the client's tools, auto-registers the connected client as a server, and exposes those tools through the normal Streamable HTTP MCP endpoint at `/mcp`.

This is useful when a tool provider cannot be launched by MCP Center as stdio and cannot be reached as an HTTP MCP server, for example:

- a browser extension or desktop app that can open an outbound WebSocket connection
- a remote worker behind NAT/firewall that can connect out to MCP Center
- a long-running app that wants to dynamically publish tools while it is connected

### Bridge lifecycle

1. Start MCP Center.
2. A bridge client connects to `ws://localhost:3000/ws/<serverName>`.
3. MCP Center sends `initialize` to the bridge client.
4. MCP Center sends `tools/list` to discover tools.
5. The bridge client appears in the Web UI as a `WSBRIDGE` server.
6. Tools are exposed to MCP clients with the same server-name prefix rule, for example `agent1_echo`.
7. When an MCP client calls that tool through `/mcp`, MCP Center forwards a `tools/call` request over the WebSocket.
8. When the WebSocket disconnects, the bridge server is removed from the loaded capability list.

If another WebSocket connects with the same `serverName`, the previous connection for that name is closed and replaced.

### Bridge protocol

The bridge connection uses JSON-RPC 2.0 messages over WebSocket.

After the WebSocket upgrade, MCP Center sends:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-03-26",
    "capabilities": {},
    "clientInfo": {
      "name": "mcp-center",
      "version": "1.0.0"
    }
  }
}
```

The bridge client should return a JSON-RPC result, for example:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-03-26",
    "capabilities": {
      "tools": {}
    },
    "serverInfo": {
      "name": "my-agent",
      "version": "1.0.0"
    }
  }
}
```

MCP Center then sends `tools/list`:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list"
}
```

The bridge client should return tools in normal MCP shape:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {
        "name": "echo",
        "description": "Echo input text",
        "inputSchema": {
          "type": "object",
          "properties": {
            "text": {
              "type": "string"
            }
          },
          "required": ["text"]
        }
      }
    ]
  }
}
```

When an MCP client calls the exposed tool, for example `my_agent_echo`, MCP Center forwards the original tool name to the bridge client:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "echo",
    "arguments": {
      "text": "hello"
    }
  }
}
```

The bridge client should return a normal MCP tool result:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "hello"
      }
    ]
  }
}
```

If a request fails, return a JSON-RPC error:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "error": {
    "code": -32000,
    "message": "Something went wrong"
  }
}
```

### Minimal bridge client example

Install `ws` in your client project, then run this script while MCP Center is running:

```js
import WebSocket from 'ws';

const serverName = 'demo-agent';
const ws = new WebSocket(`ws://localhost:3000/ws/${encodeURIComponent(serverName)}`);

const tools = [
  {
    name: 'echo',
    description: 'Echo input text',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' }
      },
      required: ['text']
    }
  }
];

ws.on('open', () => {
  console.log(`Connected to MCP Center as ${serverName}`);
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (!msg || msg.jsonrpc !== '2.0' || msg.id == null) return;

  if (msg.method === 'initialize') {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: '1.0.0' }
      }
    }));
    return;
  }

  if (msg.method === 'tools/list') {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools }
    }));
    return;
  }

  if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params || {};
    if (name === 'echo') {
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [
            { type: 'text', text: String(args.text ?? '') }
          ]
        }
      }));
    } else {
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Unknown tool: ${name}` }
      }));
    }
  }
});

ws.on('close', () => console.log('Disconnected from MCP Center'));
ws.on('error', (err) => console.error('WebSocket error:', err));
```

After the script connects, open `http://localhost:3000/ui`. You should see `demo-agent` with type `WSBRIDGE`. MCP clients connected to `http://localhost:3000/mcp` can call the tool as:

```text
demo-agent_echo
```

### WebSocket bridge notes and limits

- Bridge servers are not stored in `mcp.json`; they are auto-registered while connected.
- Bridge servers are shown in the UI as read-only entries.
- Only tools are loaded from bridge clients.
- Tool calls over the bridge time out after 60 seconds.
- Handshake/list requests time out after 15 seconds.
- MCP Center sends WebSocket ping frames every 30 seconds as keepalive.
- Server names are taken from the URL path and sanitized only when constructing aggregated tool names: characters outside `[a-zA-Z0-9_-]` become `_`.
- There is no authentication or authorization on `/ws/:serverName` in the current implementation. If exposing MCP Center beyond localhost, put it behind a trusted network boundary or reverse proxy that enforces access control.

## How It Works

MCP Center acts as a proxy in front of multiple child servers:

- configured child servers can be HTTP MCP servers or local stdio MCP servers
- WebSocket bridge clients can connect dynamically without being added to config
- MCP Center connects to configured child servers as a client
- MCP Center lists their capabilities and republishes them through one HTTP endpoint
- calls and reads are forwarded to the original child server or bridge client

Capability filtering is applied per configured HTTP/stdio child server:

- `enabledTools`
- `enabledResources`
- `enabledResourceTemplates`
- `enabledPrompts`

If a filtering field is omitted or empty, MCP Center exposes all items of that type from that child server.

Filtering does not apply to WebSocket bridge clients because they are not stored in the config file.

## OAuth Authentication

MCP Center supports importing HTTP MCP servers that require OAuth authentication. When `useOAuth: true` is set on a server config, MCP Center acts as an OAuth client and performs the full authorization flow:

1. **Discovery**: MCP Center follows RFC 9728 to find the server's OAuth protected resource metadata, then RFC 8414 to find the authorization server metadata.
2. **Dynamic client registration**: MCP Center registers itself as an OAuth client with the authorization server (RFC 7591).
3. **Authorization**: MCP Center generates a PKCE challenge and constructs the authorization URL. Since MCP Center runs as a server process (not a browser app), it stores the authorization URL and surfaces it through the Web UI.
4. **Token exchange**: After the user authorizes via their browser, the OAuth provider redirects back to MCP Center's `/oauth/callback` endpoint. MCP Center exchanges the authorization code for access and refresh tokens.
5. **Token storage**: Tokens are persisted to `~/.mcp-center/oauth-tokens.json`, keyed by server name. They survive restarts.
6. **Automatic refresh**: When a stored access token expires, the SDK automatically attempts to refresh it using the stored refresh token. If the refresh fails, MCP Center marks the server as `needs_auth` again.

### Configuring an OAuth-protected server

```json
{
  "servers": [
    {
      "name": "notion",
      "url": "https://mcp.notion.com/mcp",
      "useOAuth": true
    }
  ]
}
```

You can still include `httpHeaders` for non-auth headers. When `useOAuth` is enabled, any `Authorization` header in `httpHeaders` is ignored — OAuth manages the bearer token.

### Authorization flow in the UI

1. Add a server with `useOAuth: true` (or edit an existing one and check the "Use OAuth Authentication" checkbox).
2. Save the server. It will appear with a `needs auth` status badge.
3. Click the **Authorize** button. Your browser opens the OAuth provider's login page.
4. After you authorize, the browser redirects back to MCP Center, which exchanges the code for tokens and reloads the server automatically.
5. The server status changes to `connected`.

If the authorization URL has expired or you need to re-authorize, click **Re-authorize**.

### OAuth token storage

Tokens are stored at:

```text
~/.mcp-center/oauth-tokens.json
```

Each server entry contains:

- `tokens` — access token, refresh token, expiry, scope
- `clientInformation` — registered client ID (from dynamic registration)
- `codeVerifier` — PKCE code verifier (temporary, cleared after token exchange)
- `discoveryState` — cached RFC 9728 / RFC 8414 discovery results

To clear stored credentials for a server, use the API:

```text
POST /api/servers/:name/oauth-clear
```

Or delete the server's entry from the tokens file manually.

### OAuth API endpoints

- `GET /api/servers/:name/auth-url` — get the current auth status and authorization URL for a server
- `POST /api/servers/:name/reauth` — clear credentials and re-trigger the OAuth flow, returns a new authorization URL
- `POST /api/servers/:name/oauth-clear` — clear stored OAuth credentials for a server
- `GET /oauth/callback` — OAuth redirect callback endpoint (called by the OAuth provider after user authorization)

### OAuth notes

- The callback URL is `http://localhost:<port>/oauth/callback`. The port is determined by the `PORT` environment variable (default 3000).
- MCP Center uses `token_endpoint_auth_method: 'none'` (public client) for dynamic registration, which is the standard for non-confidential clients.
- Token refresh is handled automatically by the SDK. If a refresh fails, the server status changes to `needs_auth` and the user must re-authorize via the UI.
- If MCP Center is exposed beyond localhost, the `/oauth/callback` endpoint has no authentication. Put it behind a trusted network boundary or reverse proxy.

## Configuration File

The config file format is:

```json
{
  "servers": [
    {
      "name": "exa",
      "url": "https://mcp.exa.ai/mcp",
      "httpHeaders": {
        "Authorization": "Bearer YOUR_TOKEN"
      },
      "enabledTools": ["web_search_exa"]
    },
    {
      "name": "notion",
      "url": "https://mcp.notion.com/mcp",
      "useOAuth": true,
      "enabledTools": ["search", "create_page"]
    },
    {
      "name": "filesystem",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/path/to/workspace"
      ],
      "env": {
        "NODE_ENV": "production"
      },
      "enabledTools": ["read_file", "write_file"],
      "enabledResources": ["file:///path/to/workspace/README.md"],
      "enabledPrompts": ["summarize_file"]
    }
  ]
}
```

### Server Fields

Common fields:

- `name`: required, must be unique
- `enabled`: optional, set `false` to keep the server in config but not connect to it
- `enabledTools`: optional string array
- `enabledResources`: optional string array
- `enabledResourceTemplates`: optional string array
- `enabledPrompts`: optional string array

HTTP child server fields:

- `url`: required for HTTP transport
- `httpHeaders`: optional request headers
- `useOAuth`: optional boolean, set `true` to enable OAuth authentication (RFC 9728 + RFC 8414 discovery, PKCE, dynamic client registration, token refresh)

STDIO child server fields:

- `command`: required for stdio transport
- `args`: optional argument array
- `env`: optional environment variables, merged with the current process environment

WebSocket bridge clients do not use config fields. They connect directly to `/ws/:serverName`.

## Client Configuration

The exact client config depends on the client, but the target should be the MCP Center HTTP endpoint:

```json
{
  "mcpServers": {
    "mcp-center": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

If your client expects a transport field, use its Streamable HTTP mode and point it to the same URL.

If you want to launch MCP Center from another tool or script, use the same `npx` entry:

```json
{
  "command": "npx",
  "args": [
    "-y",
    "@sunwu51/mcp-center"
  ]
}
```

## HTTP API

The Web UI uses these routes:

- `GET /api/servers`: list configured HTTP/stdio servers
- `POST /api/servers`: add a configured server
- `PUT /api/servers/:index`: update a configured server
- `DELETE /api/servers/:index`: delete a configured server
- `PATCH /api/servers/:index/toggle`: enable or disable a configured server
- `GET /api/servers/status`: get current connection status
- `GET /api/servers/:name/capabilities`: get loaded capabilities for a connected server
- `GET /api/wsbridge/servers`: list currently connected WebSocket bridge servers
- `POST /api/probe`: temporarily connect to a server config and inspect capabilities before saving
- `GET /api/servers/:name/auth-url`: get OAuth auth status and authorization URL for a server
- `POST /api/servers/:name/reauth`: clear OAuth credentials and re-trigger the OAuth flow
- `POST /api/servers/:name/oauth-clear`: clear stored OAuth credentials for a server
- `GET /oauth/callback`: OAuth redirect callback (called by the OAuth provider)

## Runtime Behavior

- Default port is `3000`
- Set `PORT` to change it
- HTTP MCP endpoint: `http://localhost:<port>/mcp`
- Web UI: `http://localhost:<port>/ui`
- WebSocket bridge endpoint: `ws://localhost:<port>/ws/:serverName`
- The config file is watched for changes
- When the config changes, MCP Center reloads configured child servers automatically
- Child servers are loaded in parallel
- Failed configured child servers do not stop the main HTTP/WebSocket service from starting

Example:

```bash
PORT=8080 npx @sunwu51/mcp-center
```

PowerShell:

```powershell
$env:PORT=8080
npx @sunwu51/mcp-center
```

## Development

Install dependencies:

```bash
npm install
```

Run locally:

```bash
npm start
```

Run tests:

```bash
npm test
```

## License

MIT
