---
name: component-to-route
description: Find Next.js routes where a React component is rendered. Use when the user asks which routes to QA or test after changing a component, wants to trace component usage up to route entrypoints, or mentions component-to-route.
---

# component-to-route

CLI that traces a React component file upward through the import/render graph to find all Next.js routes where it appears. Answers "where should I go test this component?"

## When to Use

- User changed a component and wants to know which routes to QA
- User asks "where is this component used?" in terms of routes
- User wants the import chain between a component and its route entrypoints
- User needs to understand layout/template expansion (component in a layout = all child routes)

## Invocation

```bash
component-to-route <component-path> [options]
```

### Options

| Flag | Purpose |
|------|---------|
| `--dir <path>` | Directory of the Next.js app to search (defaults to cwd) |
| `--export <name>` | Target a specific exported symbol, e.g. `Button` |
| `--json` | Full JSON output (for programmatic parsing) |
| `--no-cache` | Skip the local analysis cache |
| `--cache-dir <path>` | Override cache directory |
| `--no-build-artifacts` | Skip `.next` manifest enrichment |
| `--dynamic-imports` | Follow `next/dynamic` and `React.lazy` imports (slower) |

### Examples

```bash
# From the app root
component-to-route packages/design-system/src/components/badge/badge.tsx

# Target a specific export
component-to-route src/components/button.tsx --export Button

# Monorepo: specify the app directory
component-to-route packages/design-system/src/components/button/button.tsx --dir apps/web
```

## Reading the Output

Default output is a compact markdown-like format:

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

Each route section shows:
- **Route path** as the heading
- **Confidence** (`high`, `medium`, `low`) and context notes in parentheses
- **File chain** from route entry down to the target component via `->` arrows

Pass `--json` for the full typed `ComponentToRouteResult` object when you need to post-process individual fields programmatically.

## Agent Usage Patterns

Prefer the default output -- it is compact and low-token. Only use `--json` when you need to parse specific fields.

### After editing a component, find routes to verify

```bash
component-to-route src/components/pricing-card.tsx
```

Read the output and tell the user which routes to check.

### In a monorepo, specify the app directory

```bash
component-to-route packages/design-system/src/button.tsx --dir apps/web
```

### Interpret confidence levels

- **high**: component is directly rendered in a page file
- **medium**: reached via layout expansion or thin wrapper
- **low**: reached through re-exports, barrels, or dynamic patterns -- still worth checking but may be a false positive
