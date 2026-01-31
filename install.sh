#!/usr/bin/env bash
set -euo pipefail

echo "Installing sessionr - Unified Session Picker for Codex, Claude, and Copilot"
echo ""

# Check for Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required but not installed."
  echo "Install Node.js 18+ from https://nodejs.org/"
  exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "Error: Node.js 18+ is required (found v$NODE_VERSION)"
  exit 1
fi

# Install dependencies and build
echo "Installing dependencies..."
npm install --silent

echo "Building..."
npm run build --silent

# Link globally
echo "Linking globally..."
npm link --silent 2>/dev/null || {
  echo ""
  echo "Note: 'npm link' failed (may need sudo). You can run manually:"
  echo "  sudo npm link"
  echo ""
  echo "Or add to your PATH:"
  echo "  export PATH=\"\$PATH:$(pwd)/dist\""
}

echo ""
echo "✅ Installation complete!"
echo ""
echo "Available commands:"
echo "  sessionr          - Interactive session picker (all CLIs)"
echo "  sessionr list     - List all sessions"
echo "  sessionr codex    - Resume newest Codex session"
echo "  sessionr claude   - Resume newest Claude session"
echo "  sessionr copilot  - Resume newest Copilot session"
echo ""
echo "Run 'sessionr --help' for more options."

# Optional: Add shell aliases for backward compatibility
SHELL_RC="${SHELL_RC:-$([ -n "${ZSH_VERSION-}" ] && echo "$HOME/.zshrc" || echo "$HOME/.bashrc")}"
BLOCK_START="# >>> sessionr-aliases >>>"
BLOCK_END="# <<< sessionr-aliases <<<<"

read -p "Add convenience aliases (codexr, claur, copr) to $SHELL_RC? [y/N] " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
  # Remove old block if exists
  if grep -q "$BLOCK_START" "$SHELL_RC" 2>/dev/null; then
    awk -v start="$BLOCK_START" -v end="$BLOCK_END" '
      $0 ~ start {flag=1; next}
      $0 ~ end {flag=0; next}
      !flag {print}
    ' "$SHELL_RC" > "${SHELL_RC}.tmp"
    mv "${SHELL_RC}.tmp" "$SHELL_RC"
  fi

  cat >> "$SHELL_RC" <<EOF

$BLOCK_START
# Sessionr - Unified Session Picker aliases
alias codexr='sessionr codex'
alias claur='sessionr claude'
alias copr='sessionr copilot'
$BLOCK_END
EOF

  echo ""
  echo "✅ Aliases added. Reload your shell:"
  echo "   source $SHELL_RC"
fi
