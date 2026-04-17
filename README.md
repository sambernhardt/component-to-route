# component-to-route

Traces a React component upward through the import/render graph to find all Next.js routes where it appears. Answers the question: **where should I go test this component?**

Useful after editing a shared component in a large app or monorepo — instead of guessing which routes to QA, you get a list with the file chain explaining how each route reaches the component.

## How it works

The CLI performs static analysis on your codebase:

1. Resolves the exported component symbols from the target file
2. Builds a render-usage index (distinguishes "imported" from "actually rendered in JSX")
3. Walks upward through the import/render graph
4. Stops at Next.js route entrypoints (`page.tsx`, `layout.tsx`, etc.)
5. Expands layouts and templates into the concrete routes they affect

Supports both App Router and Pages Router. Works on monorepos with workspace packages and tsconfig path aliases.

## Installation

### As a Claude Code / Cursor skill

```bash
npx skills add <github-repo>
```

Once installed, the agent will automatically invoke `component-to-route` after editing components, and you can ask things like:
- "which routes should I QA after this change?"
- "where is this component rendered?"

### As a standalone CLI

Run from your workspace root (the directory containing your top-level `package.json`):

```bash
npm install -g github:sambernhardt/component-to-route
```

Or without installing:

```bash
npx github:sambernhardt/component-to-route <component-path>
```

## Usage

```bash
component-to-route <component-path> [options]
```

**Run from your workspace root.** In a monorepo, use `--dir` to point at the Next.js app.

### Options

| Flag | Purpose |
|------|---------|
| `--dir <path>` | Directory of the Next.js app to search (defaults to cwd) |
| `--export <name>` | Target a specific exported symbol, e.g. `Button` |
| `--json` | Full JSON output for programmatic parsing |
| `--no-cache` | Skip the local analysis cache |
| `--cache-dir <path>` | Override the cache directory |
| `--no-build-artifacts` | Skip `.next` manifest enrichment |
| `--dynamic-imports` | Follow `next/dynamic` and `React.lazy` imports (slower) |

### Examples

```bash
# Single-app repo
component-to-route src/components/button.tsx

# Target a specific named export
component-to-route src/components/button.tsx --export Button

# Monorepo: component lives in a package, app is in apps/web
component-to-route packages/design-system/src/components/badge/badge.tsx --dir apps/web
```

### Example output

```
# component-to-route

> Badge from `packages/design-system/src/components/badge/badge.tsx`
> 3 routes found

## /docs (high)
  -> app/docs/page.tsx
  -> components/docs-page.tsx
  -> packages/design-system/src/components/badge/badge.tsx

## /account (medium, shared layout)
  -> app/account/layout.tsx
  -> components/account-shell.tsx
  -> components/status-chip.tsx
  -> packages/design-system/src/components/badge/badge.tsx

## /settings (medium, shared layout)
  -> app/settings/page.tsx
  -> components/settings-panel.tsx
  -> packages/design-system/src/components/badge/badge.tsx
```

Each route shows a confidence level and the file chain from route entrypoint down to the target component.

**Confidence levels:**
- `high` — component is directly rendered in a page file
- `medium` — reached via layout expansion or a thin wrapper
- `low` — reached through re-exports, barrels, or dynamic patterns; still worth checking but may be a false positive
