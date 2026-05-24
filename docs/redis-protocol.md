> **Source of truth**: gonzih/money-brain `research/cc-suite-redis-protocol.md`
> This file is a local copy for reference. If the upstream document diverges, upstream wins.

# cc-suite Redis Protocol

## Overview

The cc-suite components communicate through Redis using a well-defined set of keys and channels. This document describes the protocol that cc-agent-ui must comply with.

## Key Space

### Job Keys (MCP boundary — server only)
| Key | Type | Description |
|-----|------|-------------|
| `cca:jobs:{namespace}` | SET | Job IDs per namespace |
| `cca:job:{UUID}` | STRING (JSON) | Full job metadata |
| `cca:job:{UUID}:output` | LIST | Log lines (append-only, RPUSH) |
| `cca:job:{UUID}:signal` | STRING | Control signal (`cancel`, `wake`) |
| `cca:job:{UUID}:input` | LIST | Messages queued for the running job |

**MCP boundary**: The browser NEVER reads `cca:job:{id}` directly. All job data must come through MCP tool calls (`get_job_status`, `list_jobs`, `get_job_output`). The cc-agent-ui server acts as the MCP proxy layer — it reads these keys on behalf of the browser.

### Chat Keys
| Key | Type | Description |
|-----|------|-------------|
| `cca:chat:log:{ns}` | LIST | Chat history — **LIFO** (LPUSH, newest first) |
| `cca:chat:incoming:{ns}` | CHANNEL | UI → cc-tg/coordinator publish channel |
| `cca:chat:outgoing:{ns}` | CHANNEL | cc-tg → UI publish channel |
| `cca:notify-log:{ns}` | LIST | Notification log — **LIFO** (LPUSH, newest first) |

#### Chat log ordering
`cca:chat:log:{ns}` is stored LIFO using LPUSH. When reading with LRANGE 0 N, the result is **newest first**. To display in chronological order (oldest at top, newest at bottom), the result MUST be reversed (`.reverse()`) before rendering.

The same applies to `cca:notify-log:{ns}`.

#### Chat outgoing timing
`cca:chat:outgoing:{ns}` is published by cc-tg after an **800ms debounce** from the last Claude streaming chunk. The UI should not expect real-time delivery of partial messages.

#### Coordinator poll gap
The coordinator polls for job completion at up to **2s intervals**. There may be up to 2s delay between a job completing and its notification appearing in `cca:notify-log:{ns}` or the chat stream.

### Meta-Agent Keys
| Key | Type | Description |
|-----|------|-------------|
| `cca:meta:agents:index` | SET | Canonical registry of meta-agent namespaces |
| `cca:meta:{ns}` | STRING (JSON) | Meta-agent state |
| `cca:meta:{ns}:input` | LIST | Input queue for meta-agent |
| `cca:meta-agent:status:{ns}` | STRING (JSON) | Live meta-agent status (typing, tool, etc.) |

### Version Keys
| Key | Type | Description |
|-----|------|-------------|
| `cca:meta:cc-agent:version` | STRING | cc-agent version string |
| `cca:meta:cc-tg:version` | STRING | cc-tg version string |

### Cron Keys
| Key | Type | Description |
|-----|------|-------------|
| `cca:crons:{namespace}` | STRING (JSON array) | Cron job definitions |

## ChatMessage Shape

```typescript
interface ChatMessage {
  id: string;                                           // UUID
  source: 'telegram' | 'ui' | 'claude' | 'cc-tg';     // message origin
  role: 'user' | 'assistant' | 'tool';                 // conversation role
  content: string;                                      // message body
  timestamp: string;                                    // ISO 8601 timestamp
  chatId: number;                                       // Telegram chat ID (0 for UI)
}
```

### Rules for UI-originated messages
- `source` MUST be `"ui"`
- `role` MUST be `"user"`
- `timestamp` MUST be an ISO 8601 string (NOT a Unix epoch number)
- `chatId` MUST be `0`

### Who writes to cca:chat:log
**Only cc-tg writes to `cca:chat:log:{ns}`.** cc-agent-ui must NOT write to this key directly. When the UI sends a message via `cca:chat:incoming:{ns}`, cc-tg receives it, processes it, and writes the canonical log entry. This ensures consistent log ownership.

## Allowed Direct Redis Reads (cc-agent-ui)
The following keys may be read directly (not requiring MCP intermediation):
- `cca:chat:log:{ns}` — chat history
- `cca:notify-log:{ns}` — notification history
- `cca:chat:outgoing:{ns}` — live message subscription
- `cca:meta-agent:status:{ns}` — live meta-agent status
- `cca:meta:agents:index` — canonical namespace registry
- `cca:meta:{ns}` — meta-agent state
- `cca:crons:{namespace}` — cron definitions
- `cca:meta:cc-agent:version`, `cca:meta:cc-tg:version` — version strings
