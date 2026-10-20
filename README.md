# Forge

A Windows 11 desktop coding agent that runs Claude through the **official Anthropic Messages API** with your own API key. It does not use the Claude Code executable or a Claude subscription login.

![Forge conversation](docs/conversation.png)

## Why it bills your API credits

Anthropic's monthly API credits for Max and Team plans cover "The Claude API (Messages API and Message Batches API)", the Console Playground, Managed Agents and the Agent SDK. They exclude "Interactive Claude Code in the terminal, IDE, desktop, or web" ([support article](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans)). Forge calls `POST /v1/messages` on `api.anthropic.com` directly with the key you enter, so its usage is ordinary Claude API usage on that key's Console organization. It doesn't use any workaround.

## Install

1. Download `Forge-Setup-<version>.exe` (installer) or `Forge-Portable-<version>.exe` (no install) from [Releases](../../releases/latest).
2. The build is not code-signed, so SmartScreen may warn you. Click **More info → Run anyway**.
3. On first launch, paste your API key (`sk-ant-…`) and press **Save & test**. The test sends one tiny Claude Haiku 5.5 request to confirm the key can actually bill.
4. Choose a project folder and start asking.

## Features

- **Coding agent loop.** Streams `messages.stream` responses and runs tools until the task is done: `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `run_command` (PowerShell 7 if installed, otherwise Windows PowerShell), `git_status`, `git_diff` and `git_log`. Tool inputs are validated with zod and confined to the project folder; symlink and junction escapes are refused.
- **Subagents.** The `task` tool lets Claude hand broad exploration to a read-only subagent. The subagent's model and effort are configurable; the default is Sonnet 5.5 at medium effort.
- **Models.** Claude Opus 5.5 is the default. Fable 5.1, Sonnet 5.5, Haiku 5.5, Opus 5, Fable 5, Sonnet 5, Opus 4.8 and Opus 4.7 are also available. Effort can be low, medium, high, xhigh or max, with adaptive thinking and summarized thinking shown live.
- **Approvals.** Four modes: ask before edits and commands, auto-approve edits, auto-approve everything, or read-only. Approval cards show the exact diff or command. Keys: `Y` approve, `N` deny, plus "always allow" for the rest of the session.
- **Controls.** Stop (Esc) kills running commands and keeps the partial answer. Continue resumes after a stop, the output limit, the step limit or an error.
- **Sessions.** Create, rename (double-click), delete, search and resume sessions. The full API history is saved to disk, including thinking signatures, so resumed conversations remain valid for the API.
- **Spending.**
  - Every request's token usage (input, output, cache reads and writes) is recorded, and its cost is estimated from Anthropic's published prices.
  - You can set per-session, daily and monthly limits; they are checked before each request.
  - Forge never shows a credit balance, because it cannot read one. Check yours at the Console's Billing page.
- **Git and diffs.** The Changes panel shows the diffs Claude made this session. The Git panel shows status, a per-file `git diff` and recent commits.
- **Security.**
  - The API key is encrypted with Windows DPAPI through Electron `safeStorage`. It is never written in plaintext or sent to the renderer.
  - The renderer runs sandboxed with context isolation, no Node access and a strict Content Security Policy.
  - Requests always go to `https://api.anthropic.com`. `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` from the environment are ignored.
- **Cost-aware requests.** Prompts are cached, which makes repeated context much cheaper. Tool input is streamed eagerly, so long file writes appear as they're generated. Refusal fallback (`fallbacks: "default"`) is optional and on by default.

| Approvals | Usage |
|---|---|
| ![approval](docs/approval.png) | ![usage](docs/usage.png) |

## Develop

```bash
npm install
npm run dev          # Electron + Vite with hot reload
npm run typecheck
npm test             # unit tests (agent loop, tools, stores, pricing)
npm run test:e2e     # drives the real app against a local mock of the Messages API (use xvfb-run on Linux)
npm run dist:win     # build the NSIS installer and portable EXE (on Windows)
```

Stack: Electron 44, React 19, TypeScript, Vite (electron-vite), and the official `@anthropic-ai/sdk`.

- `src/main/agent/agent.ts`: the agent loop.
- `src/main/agent/tools.ts`: the tools.
- `src/renderer/src`: the UI.

CI (`.github/workflows/release.yml`) does the following on every push:

- Runs the tests on Linux and on Windows.
- Builds both Windows executables, smoke-tests the packaged `Forge.exe` and uploads the executables as artifacts.
- On `main`, also publishes a GitHub Release.
