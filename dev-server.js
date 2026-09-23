// Local static server for the app (npm start). Production is served by Vercel as a plain static
// site + /api functions (vercel.json sets "framework": null).
// Uses Node's built-in http module on purpose: having Express in package.json (or a root
// server.js/app.js/index.js) makes Vercel deploy the whole site as an Express app, which breaks
// sw.js/manifest.json and fails with "No entrypoint found". The /api alert functions don't run here - use `vercel dev`.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  let filePath = path.join(ROOT, urlPath);

  // Stay inside the project folder
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end();
  }

  // Serve the file if it exists, otherwise fall back to index.html
  fs.stat(filePath, (err, stat) => {
    if (err || stat.isDirectory()) filePath = path.join(ROOT, "index.html");
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(500);
        return res.end("Server error");
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream" });
      res.end(data);
    });
  });
}).listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
