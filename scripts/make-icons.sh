#!/usr/bin/env bash
#
# icons/*.svg から icons/icon-{16,32,48,128}.png を再生成する。
#
# レンダリングには @resvg/resvg-js を使う。CLI 版はまだ beta しか無いため、
# 使い捨ての node_modules を /tmp に作ってライブラリを直接叩く。
# このリポジトリのツリーとグローバル環境は一切汚さない（拡張機能本体に
# npm 依存は無い）。
#
# どこからでも実行できる:
#   bash scripts/make-icons.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

RESVG_VERSION="2.6.2"

TMPDIR_RESVG="$(mktemp -d -t resvg-icons-XXXXXX)"
trap 'rm -rf "$TMPDIR_RESVG"' EXIT
echo "Installing @resvg/resvg-js@${RESVG_VERSION} into ${TMPDIR_RESVG}..."
(cd "$TMPDIR_RESVG" && npm install --silent --no-save --no-audit --no-fund \
  --prefix "$TMPDIR_RESVG" "@resvg/resvg-js@${RESVG_VERSION}")

RENDER_SCRIPT="$TMPDIR_RESVG/render.mjs"
cat > "$RENDER_SCRIPT" <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(process.env.RESVG_PREFIX + "/");
const { Resvg } = require("@resvg/resvg-js");
const [src, sizeStr, out] = process.argv.slice(2);
const size = Number(sizeStr);
const svg = readFileSync(src);
const png = new Resvg(svg, {
  fitTo: { mode: "width", value: size },
}).render().asPng();
writeFileSync(out, png);
EOF

render() {
  local src=$1 size=$2 out=$3
  RESVG_PREFIX="$TMPDIR_RESVG/node_modules" \
    node "$RENDER_SCRIPT" "$src" "$size" "$out"
  echo "  wrote $out (${size}x${size})"
}

echo "Regenerating icons/*.png..."
render icons/icon-16.svg 16  icons/icon-16.png
render icons/icon.svg    32  icons/icon-32.png
render icons/icon.svg    48  icons/icon-48.png
render icons/icon.svg    128 icons/icon-128.png
echo "Done."
