#!/usr/bin/env bash
# Guarda public/ en la rama "feeds" para recuperar los feeds anteriores si VTEX falla.
set -euo pipefail
cd public
rm -rf .git
git init -q -b feeds
git config user.name "github-actions[bot]"
git config user.email "41898283+github-actions[bot]@users.noreply.github.com"
git add -A
git commit -qm "Feeds $(date -u +%Y-%m-%dT%H:%MZ)"
git push -qf "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" feeds
rm -rf .git
