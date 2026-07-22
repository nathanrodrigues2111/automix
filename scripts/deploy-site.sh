#!/usr/bin/env bash
# Publish the landing page (site/) to the public
# nathanrodrigues2111/automix-site repo (GitHub Pages). Source stays private.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="nathanrodrigues2111/automix-site"

TMP=$(mktemp -d)
cp -r site/* "$TMP/"
touch "$TMP/.nojekyll"
cd "$TMP"
git init -q -b main
git add -A
git commit -q -m "Deploy $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push -f "https://github.com/$REPO.git" main
cd - >/dev/null
rm -rf "$TMP"
echo "Deployed: https://nathanrodrigues2111.github.io/automix-site/"
