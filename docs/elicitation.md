# ACP v1 elicitation

The gateway uses `@agentclientprotocol/sdk` v1 methods, request/response types,
and validated variant guards. Protocol reference:
https://agentclientprotocol.com/protocol/v1/elicitation

`AgentConnection` advertises `ClientCapabilities.elicitation` and registers the
SDK's `methods.client.elicitation.create` / `.complete`. Requests keep their
original session/tool-call scope or request scope. The gateway does not infer a
missing session ID from the current prompt. HTTP interactions use a separate
local correlation ID; the agent's URL `elicitationId` remains opaque.

Forms render from the SDK's `requestedSchema`, with arbitrary property names.
String, integer, number, boolean, single-select and multi-select fields support
defaults, review/edit before submission, client/server validation and explicit
accept, decline and cancel. There is no automatic submission on option selection
and no heuristic parsing of provider-private `questions`/`choices` payloads.

URL requests display the requesting agent, destination host and full URL.
Only explicit consent opens the system browser with an isolated window context;
the ACP response is `accept` without form content. Accepted requests remain in
the waiting state until a matching SDK completion notification arrives, the
local notice is dismissed, or the connection/session/timeout clears it.
Unknown/repeated completion notifications are ignored. The UI recovers pending
requests and URL completion via the authenticated pending endpoint even after
the original chat SSE stream has ended or the renderer has reloaded.

Each interaction manager owns one ACP connection. Cancel/timeout/disconnect
remove pending state and timers; no pending request is reused across connections.
Malformed or unsupported modes/schema/URLs are rejected with the SDK's
`RequestError.invalidParams`. Invalid answers remain editable rather than
consuming the outstanding request.

## OpenCode boundary

Client support does not make an agent emit ACP requests. Installed OpenCode
2.0.6 has a documented upstream native-form forwarding limitation; the current
`@yitom/acp-client` 0.1.11 adapter prepares a native-question deny fallback for
known affected versions. This work does not override that safeguard or claim
native OpenCode questions passed live model testing. Standard elicitation is
tested with an agent using the official ACP SDK, through the real gateway and
Electron UI. An OpenCode release/adapter that forwards standard requests will
use the same handlers without provider-specific field mappings.

## Verification

- `tests/universal/elicitation-protocol.test.ts`: actual SDK request/response and
  completion, schema values, cancellation, timeouts, duplicate IDs and ownership.
- `tests/universal/elicitation-opencode.test.tsx`: dynamic SDK-schema forms,
  review/edit/validation, independent actions, URL consent, retries and submission
  deduplication. The filename is retained from the earlier private-payload tests.
- `e2e/acp-interactions-electron.spec.ts`: real Electron → HTTP/SSE → stdio ACP →
  reverse request → UI → original waiting request; URL completion after chat ends.
