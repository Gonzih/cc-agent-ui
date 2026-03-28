# cc-agent-ui

Live browser canvas UI for [cc-agent](https://github.com/Gonzih/cc-agent) jobs.

Infinite pannable/zoomable grid of terminal cards — one per job — with live streaming output, file browser, and real-time status updates.

![cc-agent-ui screenshot](https://raw.githubusercontent.com/Gonzih/cc-agent-ui/main/screenshot.png)

## Features

- **Infinite canvas** — pan (drag), zoom (scroll wheel / pinch), 1300+ jobs no problem
- **Live streaming output** — Redis-backed polling, new lines appear in real time
- **File browser** — click any file path in terminal output to browse/view it inline (code, images, video, audio)
- **Filters** — all / live / done / err, hides cards from canvas too
- **Namespace support** — multi-namespace cc-agent setups work out of the box
- **Auto-restarts** — runs as a launchd service (macOS), survives crashes/reboots

## Requirements

- Node.js 18+
- Redis running at `localhost:6379`
- [cc-agent](https://github.com/Gonzih/cc-agent) writing job data to Redis (`cca:jobs:*` keys)

## Install

```bash
git clone https://github.com/Gonzih/cc-agent-ui.git
cd cc-agent-ui
npm install
```

## Run

```bash
npm start
# or with custom port
PORT=7701 node server.js
```

Opens at `http://localhost:7701`.

## Run as macOS service (auto-start on login)

```bash
# Edit the plist to match your username/paths
cp launchd/cc-agent-ui.plist ~/Library/LaunchAgents/cc-agent-ui.plist

# Load it
launchctl load ~/Library/LaunchAgents/cc-agent-ui.plist

# Logs
tail -f ~/.cc-agent/logs/ui.log
```

## Redis key schema (cc-agent)

| Key | Type | Contents |
|-----|------|----------|
| `cca:jobs:{namespace}` | SET | Job UUIDs |
| `cca:job:{uuid}` | STRING | JSON job metadata |
| `cca:job:{uuid}:output` | LIST | Log lines (append-only) |

Disk fallback: `~/.cc-agent/jobs/{uuid}.log` if Redis list is empty.

## Keyboard / Mouse

| Action | Gesture |
|--------|---------|
| Pan | Drag empty canvas |
| Zoom | Scroll wheel / pinch |
| Focus job | Click sidebar item |
| Browse file | Click orange path in terminal |
| Filter | all / live / done / err buttons |

## Tailscale / network access

Binds to `0.0.0.0` by default — accessible from any device on your Tailscale network at `http://<tailscale-ip>:7701`.
