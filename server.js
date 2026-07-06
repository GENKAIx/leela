const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;

function loadLocalEnv() {
  const envPath = path.join(root, ".env.local");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) process.env[key] = value;
  }
}

loadLocalEnv();

const port = Number(process.env.PORT || 4173);
const model = process.env.OPENROUTER_MODEL || "x-ai/grok-4";
const openRouterUrl = "https://openrouter.ai/api/v1/chat/completions";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif"
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function extractText(data) {
  return data.choices?.[0]?.message?.content || "";
}

function buildMessages(payload) {
  const recent = Array.isArray(payload.messages) ? payload.messages.slice(-12) : [];
  const messages = [
    {
      role: "system",
      content: String(payload.system || "")
    }
  ];

  messages.push(...recent
    .filter((message) => message && (message.role === "user" || message.role === "assistant" || message.role === "master"))
    .map((message) => ({
      role: message.role === "master" ? "assistant" : message.role,
      content: String(message.content || "")
    })));

  messages.push({
    role: "user",
    content: [
      "Контекст последнего хода Лилы:",
      JSON.stringify({
        state: payload.state,
        move: payload.move,
        user: payload.user
      }, null, 2),
      "",
      "Ответь строго как Мастер Лилы по системному промпту. Не бросай кубик заново: бросок уже совершен интерфейсом."
    ].join("\n")
  });

  return messages;
}

async function handleLeelaChat(req, res) {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!process.env.OPENROUTER_API_KEY) {
    sendJson(res, 500, { error: "OPENROUTER_API_KEY is not set" });
    return;
  }

  try {
    const payload = JSON.parse(await readBody(req));
    const response = await fetch(openRouterUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "http://localhost:4173",
        "X-OpenRouter-Title": process.env.OPENROUTER_APP_TITLE || "Leela GPT Chat"
      },
      body: JSON.stringify({
        model,
        messages: buildMessages(payload),
        max_tokens: 900,
        temperature: 0.85
      })
    });

    const data = await response.json();
    if (!response.ok) {
      sendJson(res, response.status, { error: data.error?.message || "OpenRouter API error" });
      return;
    }

    sendJson(res, 200, { reply: extractText(data) });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Server error" });
  }
}

function serveFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname === "/" ? "/outputs/leela-vector-game.html" : url.pathname);
  const filePath = path.normalize(path.join(root, pathname));

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const type = mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/leela-chat")) {
    handleLeelaChat(req, res);
    return;
  }
  serveFile(req, res);
});

server.listen(port, () => {
  console.log(`Leela GPT chat is running at http://localhost:${port}`);
});
