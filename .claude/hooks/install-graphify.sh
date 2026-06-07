#!/usr/bin/env bash
# SessionStart hook: ensure the `graphify` CLI is available so the
# vendored `/graphify` skill (.claude/skills/graphify/) can shell out
# to it in Claude Code web sessions.
#
# The skill's SKILL.md also self-installs graphifyy on first run, so
# this hook is a pre-warm, not a hard dependency. It is best-effort
# and MUST never fail a session: every path ends in `|| true`, and we
# exit 0 unconditionally.
#
# Pinned to the version the skill was vendored at — see
# .claude/skills/graphify/VENDORED.md. Bump both together.
set +e

GRAPHIFY_VERSION="0.8.33"

# Already on PATH? Nothing to do.
if command -v graphify >/dev/null 2>&1; then
  exit 0
fi

# Prefer pipx (isolated), fall back to pip --user, then a system pip.
if command -v pipx >/dev/null 2>&1; then
  pipx install "graphifyy==${GRAPHIFY_VERSION}" >/dev/null 2>&1 || true
elif command -v pip3 >/dev/null 2>&1; then
  pip3 install --user --quiet "graphifyy==${GRAPHIFY_VERSION}" >/dev/null 2>&1 \
    || pip3 install --user --quiet --break-system-packages "graphifyy==${GRAPHIFY_VERSION}" >/dev/null 2>&1 \
    || true
fi

exit 0
