# @kiro-gpt-bridge/mcp-server

An [MCP](https://modelcontextprotocol.io) server that exposes **image and
visual-asset generation tools** backed by ChatGPT Pro + DALL-E — no official
OpenAI API key required. It speaks MCP over stdio and is consumable by any MCP
client (Kiro, Claude Desktop, etc.).

> This package is part of the [KIRO-GPT Bridge](../README.md) monorepo. The MCP
> server forwards image requests to the **relay server**, which dispatches them
> to a local **browser-agent** that drives a real ChatGPT Pro session. You need
> all three running for end-to-end generation.

## What it does

It registers five tools:

| Tool                 | Use it for                                            |
|----------------------|-------------------------------------------------------|
| `generate_image`     | General-purpose image generation (fallback)           |
| `generate_logo`      | Brand marks / product logos (transparent, centered)   |
| `generate_hero`      | Hero banners, splash images, landing-page heroes      |
| `generate_icon_set`  | A coherent set of icons sharing one theme/style       |
| `generate_ui_mockup` | A visual mockup of a UI component or screen           |

Each tool builds a versioned prompt template, submits an image request to the
relay, and writes the returned image atomically to disk. On success it returns
`{ ok: true, savedPath, mimeType, prompt, requestId, assetCategory }`
(`savedPaths: string[]` for `generate_icon_set`); on failure it returns
`{ ok: false, errorCode, message }` with a closed-enum error code.

## Where files are saved

The save location is the first of these that is set:

1. The per-call `workspace_root` tool argument.
2. The `KIRO_GPT_MCP_WORKSPACE` environment variable.
3. **The local-device default** — `<home>/Downloads/kiro-gpt-bridge`
   (overridable via `KIRO_GPT_MCP_DOWNLOAD_DIR`).

So it works with **zero configuration**: install it and generated images land
in your `Downloads/kiro-gpt-bridge` folder. Point it at a project by setting
`KIRO_GPT_MCP_WORKSPACE` when you want assets inside a specific codebase.

## Configuration

| Variable                     | Required | Default                          | Meaning                                              |
|------------------------------|----------|----------------------------------|------------------------------------------------------|
| `KIRO_GPT_MCP_SECRET`        | yes      | —                                | Relay handshake secret (matches relay `KIRO_SECRET`) |
| `KIRO_GPT_MCP_RELAY_URL`     | no       | `ws://localhost:3001`            | Relay WebSocket URL                                  |
| `KIRO_GPT_MCP_WORKSPACE`     | no       | —                                | Project workspace root for saved assets              |
| `KIRO_GPT_MCP_DOWNLOAD_DIR`  | no       | `<home>/Downloads/kiro-gpt-bridge` | Local-device default save folder                   |
| `KIRO_GPT_MCP_PROMPT_REWRITE`| no       | off                              | Expand briefs into richer DALL-E prompts             |

## Register with an MCP client

```jsonc
{
  "mcpServers": {
    "kiro-gpt-bridge": {
      "command": "node",
      "args": ["./mcp-server/dist/index.js"],
      "env": {
        "KIRO_GPT_MCP_SECRET": "<your-kiro-secret>",
        "KIRO_GPT_MCP_RELAY_URL": "ws://localhost:3001"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

## Build & test

```bash
npm install          # from the monorepo root
npm run build        # builds this package (and the shared dep)
npm test             # runs this package's unit + integration tests
```

## Error codes

`RELAY_UNREACHABLE`, `WORKSPACE_REQUIRED`, `TARGET_EXISTS`, `INVALID_PROMPT`,
`IMAGE_TIMEOUT`, `CONTENT_POLICY`, `CHATGPT_UNAVAILABLE`.

See the [root README](../README.md) for the full architecture, the relay and
browser-agent setup, and the visual-asset automation steering file.
