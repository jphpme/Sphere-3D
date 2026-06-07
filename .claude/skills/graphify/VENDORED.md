# Vendored skill: graphify

This directory is a **vendored copy** of the `graphify` Claude Code
skill — a code-graph tool that turns the repo into a queryable
knowledge graph (community detection, god nodes, `query`/`path`/
`explain`). It is checked in so `/graphify` is available in every
Claude Code web session for this repo without a per-session install.

| | |
|---|---|
| Upstream | https://github.com/safishamsi/graphify |
| PyPI package | `graphifyy` |
| Vendored version | **0.8.33** |
| License | MIT |

## How it runs

- The **skill** (`SKILL.md` + `references/`) lives here and is
  loaded as a project skill.
- The **CLI** (`graphify`, from the `graphifyy` PyPI package) does
  the deterministic work (tree-sitter AST, Leiden clustering). It is
  pre-installed by the SessionStart hook
  `.claude/hooks/install-graphify.sh`; if that fails, the skill's
  own Step 1 installs it on first `/graphify` run.
- The **semantic pass** uses the host Claude session — no API key.
  graphify reads no `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`.

## Cost note

The structural pass (AST + clustering) is free and fast. The
**semantic pass costs ~1M tokens** on this repo (subagents read the
docs corpus), counted against your Claude Code usage. Run it
deliberately — before a large refactor, or periodically — not on
every commit. Outputs land in `graphify-out/` (gitignored).

## Updating

```bash
pip install -U graphifyy && graphify install --platform claude
cp -r ~/.claude/skills/graphify/* .claude/skills/graphify/
```

Then bump `GRAPHIFY_VERSION` in `.claude/hooks/install-graphify.sh`
and the version above to match, in the same commit.
