#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$ROOT_DIR/.mcpb-build"
OUTPUT="$ROOT_DIR/x402-wallet.mcpb"

echo "Building x402-wallet desktop extension..."

# 1. Clean
rm -rf "$BUILD_DIR" "$OUTPUT"
mkdir -p "$BUILD_DIR/server"

# 2. Build
echo "Compiling TypeScript..."
cd "$ROOT_DIR"
npm run build

# 3. Copy server bundle (no sourcemap)
cp "$ROOT_DIR/dist/index.js" "$BUILD_DIR/server/index.js"

# 4. Remove shebang
sed -i.bak '1s|^#!/usr/bin/env node||' "$BUILD_DIR/server/index.js"
rm -f "$BUILD_DIR/server/index.js.bak"

# 5. Install production dependencies
echo "Installing production dependencies..."
cp "$ROOT_DIR/package.json" "$BUILD_DIR/server/package.json"
cd "$BUILD_DIR/server"
npm install --omit=dev --ignore-scripts --legacy-peer-deps
rm -f package.json package-lock.json

# 6. Prune node_modules
echo "Pruning unnecessary files..."
rm -rf node_modules/typescript 2>/dev/null || true
find node_modules -name "*.map" -delete 2>/dev/null || true
find node_modules -name "*.ts" ! -name "*.d.ts" -delete 2>/dev/null || true
find node_modules -name "CHANGELOG*" -delete 2>/dev/null || true
find node_modules -name "HISTORY*" -delete 2>/dev/null || true
find node_modules -name ".eslintrc*" -delete 2>/dev/null || true
find node_modules -name ".prettierrc*" -delete 2>/dev/null || true
find node_modules -name "tsconfig*.json" -delete 2>/dev/null || true
find node_modules -name ".npmignore" -delete 2>/dev/null || true
find node_modules -type d -name "__tests__" -exec rm -rf {} + 2>/dev/null || true
find node_modules -type d -name "test" -exec rm -rf {} + 2>/dev/null || true
find node_modules -type d -name "tests" -exec rm -rf {} + 2>/dev/null || true
find node_modules -type d -name "docs" -exec rm -rf {} + 2>/dev/null || true
find node_modules -type d -name "examples" -exec rm -rf {} + 2>/dev/null || true

# Remove CJS from ESM-first deps
if [ -d "node_modules/viem" ]; then
  rm -rf node_modules/viem/_cjs 2>/dev/null || true
fi
if [ -d "node_modules/ox" ]; then
  rm -rf node_modules/ox/_cjs 2>/dev/null || true
fi

# 7. Copy manifest and icon
cp "$ROOT_DIR/manifest.json" "$BUILD_DIR/manifest.json"
if [ -f "$ROOT_DIR/icon.png" ]; then
  cp "$ROOT_DIR/icon.png" "$BUILD_DIR/icon.png"
fi

# 8. Pack
echo "Packing .mcpb bundle..."
cd "$BUILD_DIR"
zip -r "$OUTPUT" . -x "*.DS_Store" "*.git*" > /dev/null

# 9. Clean up
rm -rf "$BUILD_DIR"

SIZE=$(du -h "$OUTPUT" | cut -f1)
echo ""
echo "Done! Created: $OUTPUT ($SIZE)"
echo ""
echo "Install in Claude Desktop:"
echo "  - Double-click x402-wallet.mcpb"
echo "  - Or drag it into Claude Desktop settings"
