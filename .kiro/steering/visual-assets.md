---
inclusion: fileMatch
fileMatchPattern: "**/*.{tsx,jsx,vue,svelte,html,css,scss,astro}"
---

# Visual Assets Steering — kiro-gpt-bridge

> **Cites: R32.1, R32.2** of `.kiro/specs/kiro-gpt-bridge/requirements.md`.
>
> The `kiro-gpt-bridge` MCP server exposes image-generation tools that route
> through ChatGPT. Whenever you (the Kiro main agent) generate frontend code
> that references an image, logo, hero banner, icon, illustration, background,
> or UI mockup, you **MUST** call `kiroGpt.generateImage` (or one of the
> sibling MCP tools listed below) **instead of** leaving placeholder paths,
> `TODO: add image` comments, lorem-picsum URLs, `data:` stubs, or unresolved
> `import` references. After the tool returns, update the generated code to
> reference the exact `savedPath` it returned.

## Available tools

All tools are exposed by the `kiro-gpt-bridge` MCP server. Each returns
`{ ok: true, savedPath, mimeType, prompt, requestId, assetCategory }` on
success or `{ ok: false, errorCode, message }` on failure.

- **`generate_logo`** — `{ brand_name, style?, color_palette?, framework?, workspace_root?, overwrite? }`
  - Use when the code references a brand logo or product mark.
- **`generate_hero`** — `{ scene_description, aspect_ratio?, framework?, workspace_root?, overwrite? }`
  - Use for hero banners, splash images, landing-page heroes.
- **`generate_icon_set`** — `{ theme, names: string[], style?, framework?, workspace_root?, overwrite? }`
  - Use when generating a coherent set of icons. Returns `savedPaths: string[]`.
- **`generate_ui_mockup`** — `{ component_description, viewport?, framework?, workspace_root?, overwrite? }`
  - Use to visualize a component before writing its code (then write code that
    matches the mockup).
- **`generate_image`** — `{ prompt, asset_category?, filename?, framework?, workspace_root?, overwrite? }`
  - General-purpose fallback when no specialized tool fits.

`workspace_root` is rarely needed; when omitted, the MCP server falls
back to the `KIRO_GPT_MCP_WORKSPACE` environment variable resolved at
launch.

## Workflow

1. While planning frontend code, identify visual assets the code will need.
2. Call the matching MCP tool and wait for `savedPath`.
3. Use `savedPath` (relative to the workspace root) in the generated code's
   `<img src="…">`, `<Image src="…">`, `import logo from '…'`, etc.
4. Do NOT emit placeholder paths or `TODO: add image` comments unless the
   user has set `kiroGptBridge.autoGenerateAssets: false`.

## Canonical asset placement (matches `pathResolver.defaultAssetDir`)

The MCP tools auto-detect the framework via `next.config.{js,ts,mjs}`,
`nuxt.config.{js,ts,mjs}`, `svelte.config.js`, `vite.config.{js,ts,mjs}`,
`angular.json`, or a `react-scripts` dependency. The base directory each
framework writes to is taken **directly from
`mcp-server/src/pathResolver.ts` → `BASE_DIR_BY_FRAMEWORK`** (the
"default asset dir" map). Do not invent alternative folders — paths in
generated code must match this table:

| Framework  | Base directory  | Example path (logo)                        |
|------------|-----------------|--------------------------------------------|
| `next`     | `public/`       | `public/logo/<slug>.png`                   |
| `nuxt`     | `public/`       | `public/logo/<slug>.png`                   |
| `vite`     | `public/`       | `public/logo/<slug>.png`                   |
| `cra`      | `public/`       | `public/logo/<slug>.png`                   |
| `sveltekit`| `static/`       | `static/hero/<slug>.png`                   |
| `angular`  | `src/assets/`   | `src/assets/icons/<slug>.png`              |
| `unknown`  | `assets/`       | `assets/<slug>.png`                        |

Within the base directory, files are placed under a per-category
subfolder driven by `SUBDIR_BY_CATEGORY` in the same file:

| Category       | Subfolder         |
|----------------|-------------------|
| `logo`         | `logo/`           |
| `hero`         | `hero/`           |
| `icon`         | `icons/`          |
| `illustration` | `illustrations/`  |
| `background`   | `backgrounds/`    |
| `mockup`       | `mockups/`        |
| `other`        | (none — files land directly under the base directory) |

The filename is derived from the prompt via `slugify(prompt, 40)`
(lowercase ASCII `[a-z0-9]+` runs collapsed to single hyphens, leading
and trailing hyphens stripped, first 40 chars of the prompt) and the
extension comes from `extensionForMime(mimeType)` (`.png`, `.jpg`,
`.webp`, or `.gif`).

## Prompt-style guidance

The MCP tools shape user-supplied parameters into final ChatGPT prompts
through the templates in **`mcp-server/src/promptTemplates.ts`**
(`PROMPT_TEMPLATES.logo`, `.hero`, `.iconSet`, `.uiMockup`, `.generic`).
When you choose tool arguments, pick descriptors that compose well with
those templates rather than restating template scaffolding:

- **`generate_logo`** — supply `brand_name` (the literal brand string),
  optional `style` (e.g. `"minimal vector"`, `"hand-drawn"`,
  `"isometric 3D"`), and optional `color_palette` (e.g.
  `"deep navy and warm gold"`). The template already adds
  "centered composition, transparent background, professional"; do not
  duplicate that phrasing in `style`.
- **`generate_hero`** — supply `scene_description` as a noun-led scene
  (e.g. `"misty alpine valley at sunrise, hot-air balloons in the
  distance"`) and an optional `aspect_ratio` (defaults to `16:9`). The
  template appends "cinematic, high detail" so prefer subject and
  composition descriptors over generic adjectives.
- **`generate_icon_set`** — supply a single coherent `theme` plus a
  `names: string[]` list. Each icon is rendered with the same `style`
  (defaults to `"flat outline"`); pick a style word that suits all
  names in the set.
- **`generate_ui_mockup`** — supply `component_description` as a UI
  noun phrase (e.g. `"settings page with tabbed navigation"`) and an
  optional `viewport` (defaults to `"desktop 1440x900"`). The template
  adds "clean modern design, realistic"; avoid restating those words.
- **`generate_image`** — pass-through. Write the full prompt yourself
  because no template wraps it.

If you find yourself wanting to override the template (e.g. you need a
specific ChatGPT prompt that the template would dilute), prefer
`generate_image` over forcing a phrase into one of the specialized
tools.

## Example call

When generating a Next.js landing page that needs a hero image:

```jsonc
{
  "tool": "generate_hero",
  "arguments": {
    "scene_description": "futuristic cityscape at golden hour, isometric view, soft purple-orange palette",
    "aspect_ratio": "16:9",
    "framework": "next"
  }
}
```

The tool returns `{ ok: true, savedPath: "public/hero/futuristic-cityscape-at-golden-hour.png", mimeType: "image/png", ... }`. Use that exact path in your `<Image src="..." />`.

## Opt-out

If the user has set `kiroGptBridge.autoGenerateAssets: false`, the panel
displays a notice that auto-generation is off and you SHOULD emit
placeholder paths or ask the user to provide images instead.
