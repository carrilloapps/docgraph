#!/usr/bin/env bash
# Self-contained installer for DocGraph. Downloads the matching platform
# package from npm and puts `docgraph`/`docgraph-mcp` on PATH. Mirrors the
# codegraph installer UX (download once, no build step).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/carrilloapps/docgraph/main/install.sh | sh
#   curl -fsSL ... | sh -s -- --version=1.2.0
#
set -euo pipefail

VERSION="${VERSION:-latest}"
PREFIX="${PREFIX:-$HOME/.docgraph}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

say() { printf "[docgraph] %s\n" "$*" >&2; }

say "Installing DocGraph (version: $VERSION) to $PREFIX"

mkdir -p "$PREFIX" "$BIN_DIR"

# Use npm to grab the platform-agnostic package — it carries the compiled
# JS that runs on any Node ≥ 18, so no per-OS bundle is needed.
if command -v npm >/dev/null; then
  TMPDIR_INSTALL="$(mktemp -d)"
  pushd "$TMPDIR_INSTALL" >/dev/null
  if [ "$VERSION" = "latest" ]; then
    npm install --prefix=. @carrilloapps/docgraph >/dev/null
  else
    npm install --prefix=. "@carrilloapps/docgraph@$VERSION" >/dev/null
  fi
  cp -R node_modules/@carrilloapps/docgraph/. "$PREFIX/"
  popd >/dev/null
  rm -rf "$TMPDIR_INSTALL"
else
  echo "[docgraph] npm is required for the install. Get it from https://nodejs.org" >&2
  exit 1
fi

# Make the compiled entry points executable — they carry a `#!/usr/bin/env
# node` shebang, so once the exec bit is set the symlinks below work directly
# without needing `node <path>`.
for entry in \
  "$PREFIX/dist/presentation/cli/cli.js" \
  "$PREFIX/dist/presentation/mcp/server.js" \
  "$PREFIX/dist/presentation/installer/installer.js"
do
  [ -f "$entry" ] && chmod +x "$entry"
done

# Symlink the binaries.
for bin in docgraph docgraph-mcp docgraph-install; do
  if [ -f "$PREFIX/dist/presentation/cli/cli.js" ] && [ "$bin" = "docgraph" ]; then
    ln -sf "$PREFIX/dist/presentation/cli/cli.js" "$BIN_DIR/docgraph"
  fi
  if [ -f "$PREFIX/dist/presentation/mcp/server.js" ] && [ "$bin" = "docgraph-mcp" ]; then
    ln -sf "$PREFIX/dist/presentation/mcp/server.js" "$BIN_DIR/docgraph-mcp"
  fi
  if [ -f "$PREFIX/dist/presentation/installer/installer.js" ] && [ "$bin" = "docgraph-install" ]; then
    ln -sf "$PREFIX/dist/presentation/installer/installer.js" "$BIN_DIR/docgraph-install"
  fi
done

say "Installed binaries to $BIN_DIR"
say "Next: add '$BIN_DIR' to PATH if not already, then run 'docgraph-install' to wire it into your AI agents."
