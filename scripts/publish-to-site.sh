#!/usr/bin/env bash
# Publish the built dashboard into the static site repo (afmedia) at
# <site>/kalshi-midterm-analysis/, with the page title, description and the
# site's favicon links from scripts/site-head.html added to index.html.
#
# Usage:
#   scripts/publish-to-site.sh
#   AFMEDIA_DIR=/path/to/site scripts/publish-to-site.sh
#   SKIP_BUILD=1 scripts/publish-to-site.sh   # use the existing web/dist
#
# This script never runs git add, commit, push or checkout. It only replaces
# the kalshi-midterm-analysis folder in the site repo and prints git status;
# review and commit there yourself.
set -euo pipefail

die() { echo "publish-to-site: $*" >&2; exit 1; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
AFMEDIA_DIR="${AFMEDIA_DIR:-$(dirname "$REPO")/afmedia}"

[ -d "$AFMEDIA_DIR" ] || die "site directory not found: $AFMEDIA_DIR (set AFMEDIA_DIR)"
AFMEDIA_DIR="$(cd "$AFMEDIA_DIR" && pwd -P)"
[ "$AFMEDIA_DIR" != "$REPO" ] || die "AFMEDIA_DIR is the race-attention repo itself: $AFMEDIA_DIR"
toplevel="$(git -C "$AFMEDIA_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
toplevel="${toplevel:+$(cd "$toplevel" && pwd -P)}"
[ "$toplevel" = "$AFMEDIA_DIR" ] || die "not the top of a git work tree: $AFMEDIA_DIR"

TARGET="$AFMEDIA_DIR/kalshi-midterm-analysis"
HEAD_FILE="$REPO/scripts/site-head.html"
[ -f "$HEAD_FILE" ] || die "missing $HEAD_FILE"

if [ "${SKIP_BUILD:-}" = "1" ]; then
  echo "SKIP_BUILD=1: using the existing web/dist"
else
  (cd "$REPO/web" && npm ci && npm run build)
fi
[ -f "$REPO/web/dist/index.html" ] || die "web/dist/index.html is missing; build first or unset SKIP_BUILD"

rm -rf "$TARGET"
mkdir -p "$TARGET" && cp -R "$REPO/web/dist/." "$TARGET/"

# Jekyll skips files and folders whose names start with "_" or "."
hidden="$(cd "$TARGET" && find . -mindepth 1 \( -name '_*' -o -name '.*' \) -print)"
[ -z "$hidden" ] || die "these paths start with \"_\" or \".\" and Jekyll would skip them:
$hidden"

python3 - "$TARGET/index.html" "$HEAD_FILE" <<'PY'
import re
import sys

page_path, head_path = sys.argv[1], sys.argv[2]
with open(page_path, encoding="utf-8") as f:
    page = f.read()
with open(head_path, encoding="utf-8") as f:
    head = f.read().rstrip("\n") + "\n"

def fail(msg):
    sys.stderr.write("publish-to-site: " + msg + "\n")
    sys.exit(1)

title_line = re.compile(r"^[ \t]*<title>.*?</title>[ \t]*\r?\n", re.M | re.I)
if len(title_line.findall(page)) != 1:
    fail("expected exactly one <title>...</title> line in " + page_path)
page = title_line.sub(lambda m: head, page, count=1)

placeholder = re.compile(
    r"^[ \t]*<link\s+rel=[\"']icon[\"']\s+href=[\"']data:,[\"']\s*/?>[ \t]*\r?\n", re.M | re.I
)
page = placeholder.sub("", page)

if page.lower().count("<title>") != 1:
    fail("index.html does not have exactly one <title> after the edit")
if "favicon-32x32.png" not in page:
    fail("index.html is missing the favicon links after the edit")
if 'href="data:,"' in page:
    fail('index.html still has the href="data:," placeholder icon')

with open(page_path, "w", encoding="utf-8") as f:
    f.write(page)
PY

echo
echo "Published to: $TARGET"
echo "Files: $(find "$TARGET" -type f | wc -l | tr -d ' ')"
echo "Size: $(du -sh "$TARGET" | cut -f1)"
echo
echo "git status of $AFMEDIA_DIR:"
git -C "$AFMEDIA_DIR" status --short
