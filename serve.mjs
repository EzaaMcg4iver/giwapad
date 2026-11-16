import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const PORT = Number(process.env.PORT ?? "4173");
const ROOT = new URL("./dist/", import.meta.url).pathname;
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
  ".json": "application/json",
};

createServer(async (req, res) => {
  try {
    const path = req.url === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]).slice(1);
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT)) throw new Error("forbidden");
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
}).listen(PORT, () => console.log(`GiwaPad serving dist/ at http://localhost:${PORT}`));
