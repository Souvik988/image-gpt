# Security Policy

## Reporting a vulnerability

If you discover a security issue, please **do not open a public issue**.
Instead, report it privately through GitHub's
[security advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
flow on this repository, or contact the maintainer directly.

You can expect an acknowledgement within a few days and a coordinated
disclosure once a fix is available.

## Security model

KIRO-GPT Bridge is designed to keep data on the user's machine:

- **No official OpenAI API.** All model interaction is driven through the
  ChatGPT Pro web UI in a local Chromium window.
- **No third-party endpoints.** The bridge does not transmit prompts, code
  context, or responses anywhere except ChatGPT Pro. There is no telemetry,
  analytics, or diagnostic endpoint.
- **Local-only persistence.** Generated assets are written only to the local
  device — a project workspace you configure, or your `Downloads` folder by
  default.
- **Shared-secret auth.** The relay authenticates the extension, the MCP
  server, and the browser-agent with shared secrets. These secrets must never
  be committed.

## Handling secrets

- `KIRO_SECRET`, `AGENT_SECRET`, and `KIRO_GPT_MCP_SECRET` are sensitive.
  Generate them with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
  ```
- The real `.env` and `.kiro/settings/mcp.json` are **gitignored**. Commit only
  the `.env.example` and `.kiro/settings/mcp.json.example` templates.
- The browser-agent's persistent Chromium profile (`.agent-profile/`) contains
  your ChatGPT login cookies and is gitignored. Never share or commit it.

## Supported versions

The latest release on the default branch is the supported version. Security
fixes are applied there.
