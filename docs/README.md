# Docs

| Doc | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | How the web app, Firestore, workers, WhatsApp and the AI models fit together. Command flow, message intake, the data model and the repo layout. For developers. |
| [fleet.md](fleet.md) | The multi-server protocol: leases, failover, moving accounts, the encrypted login vault, AI policy and the old-server guard. |
| [multi-server.md](multi-server.md) | Running several servers: failover timings, one key per device, Gemini-only servers, Local only vs Local first, pin and move, upgrading safely. |
| [migrate-to-nothing-bot-server.md](migrate-to-nothing-bot-server.md) | The rename to Nothing BOT Server: the naming scheme, why pre-rename servers must be reinstalled (their update site is retired), and the step-by-step move (vault restore, local backup, uninstallers). |
| [agent.md](agent.md) | The agent number: a second WhatsApp number that talks to the curator, what it answers and does, and how it stays safe. |
| [mac-server.md](mac-server.md) | Turn a Mac into the server with the Nothing BOT Server app. |
| [windows-server.md](windows-server.md) | Turn a Windows 10 or 11 PC into the server: the zip, the PowerShell one-liner and what the installer sets up. |
| [ubuntu-usb-server.md](ubuntu-usb-server.md) | Turn an old laptop into the server with Ubuntu installed onto a USB drive (also works on any Ubuntu or Debian machine). |
| [plans/](plans) | Decision records: the comic app (now built as Nothing BOT Comedy), rooms and rosters, the agent number. |
| [press/cover.html](press/cover.html) | HTML source for the DEV cover image (`apps/web/public/press/cover.jpg`). |

Elsewhere in the repo:

- [apps/comic/README.md](../apps/comic/README.md): running Nothing BOT Comedy locally and what it does.

- [CONTRIBUTING.md](../CONTRIBUTING.md): setup, checks, commit style and the opt-in messaging rule.
- [SECURITY.md](../SECURITY.md): how to report a vulnerability, what is sensitive and how it is protected.
