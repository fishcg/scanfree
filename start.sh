#!/usr/bin/env bash
# 全民扫描 —— 启动脚本
#
# 为什么要脚本而不是"双击 index.html"：
# 直接双击 file:// 打开时浏览器会禁用两个关键能力——摄像头（getUserMedia 要求安全上下文）
# 和 Service Worker（离线缓存），而且部分浏览器连 IndexedDB 都会限制。
# 所以这里起一个"只监听本机"的小服务器，让它变成一个真正的本地 App。
#
# 用起来就是一行：./start.sh
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-8080}"
HOST="127.0.0.1"

# 端口被占就往后找（最多试 20 个），免得用户看到"Address already in use"一脸茫然
find_port() {
  local p="$1"
  for _ in $(seq 1 20); do
    if ! (exec 3<>"/dev/tcp/$HOST/$p") 2>/dev/null; then
      echo "$p"; return 0
    fi
    exec 3<&- 2>/dev/null || true
    p=$((p + 1))
  done
  echo "$1"
}

PORT="$(find_port "$PORT")"

echo ""
echo "  全民扫描 · 免费扫描 App"
echo "  ────────────────────────────────────────"
echo "  地址：http://$HOST:$PORT"
echo ""
echo "  手机想用？把上面这个地址换成电脑的局域网 IP，"
echo "  手机浏览器打开后点「添加到主屏幕」，就是一个 App。"
echo ""
echo "  按 Ctrl+C 退出。你的文件全部留在本机，不会被上传。"
echo ""

# 打开浏览器（macOS 用 open，Linux 用 xdg-open；失败也不影响服务）
open_browser() {
  sleep 1
  if command -v open >/dev/null 2>&1; then open "http://$HOST:$PORT" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://$HOST:$PORT" >/dev/null 2>&1 || true
  fi
}
open_browser &

# 起服务器：优先 python3（macOS/Linux 自带），退回到 node
if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "$PORT" --bind "$HOST"
elif command -v node >/dev/null 2>&1; then
  exec node -e '
    const http = require("http"), fs = require("fs"), path = require("path");
    const root = process.cwd();
    const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
      ".webmanifest": "application/manifest+json; charset=utf-8", ".svg": "image/svg+xml",
      ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8" };
    http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p.endsWith("/")) p += "index.html";
      const file = path.join(root, path.normalize(p).replace(/^(\.\.[\/\\])+/, ""));
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("404 Not Found"); }
        res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" });
        res.end(data);
      });
    }).listen(Number(process.env.PORT), process.env.HOST);
  '
else
  echo "没找到 python3 或 node，装一个就能用了。" >&2
  exit 1
fi
