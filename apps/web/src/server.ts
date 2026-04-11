import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function getApiBaseUrl(env: NodeJS.ProcessEnv): string {
  return env.VITE_API_BASE_URL ?? "http://localhost:3000";
}

function getPort(env: NodeJS.ProcessEnv): number {
  const raw = env.WEB_PORT;
  const parsed = raw ? Number(raw) : 5173;

  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5173;
}

export function buildConfigScript(env: NodeJS.ProcessEnv = process.env): string {
  return `window.__CASSANDRA_CONFIG__ = ${JSON.stringify({
    apiBaseUrl: getApiBaseUrl(env),
  })};\n`;
}

function sendJson(
  reply: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  reply.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  reply.end(JSON.stringify(body));
}

async function sendFile(reply: ServerResponse, pathname: string): Promise<void> {
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safePath === "/" ? "index.html" : safePath.slice(1));

  try {
    await access(filePath);
  } catch {
    sendJson(reply, 404, {
      error: "Not found",
    });
    return;
  }

  const contentType = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";

  reply.writeHead(200, {
    "content-type": contentType,
  });

  createReadStream(filePath).pipe(reply);
}

export function createWebServer(env: NodeJS.ProcessEnv = process.env): Server {
  return createServer(async (request, reply) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const pathname = requestUrl.pathname;

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(reply, 405, {
        error: "Method not allowed",
      });
      return;
    }

    if (pathname === "/health") {
      sendJson(reply, 200, {
        status: "ok",
      });
      return;
    }

    if (pathname === "/config.js") {
      reply.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
      });
      reply.end(buildConfigScript(env));
      return;
    }

    if (pathname === "/") {
      await sendFile(reply, "/index.html");
      return;
    }

    if (pathname === "/app.js" || pathname === "/styles.css") {
      await sendFile(reply, pathname);
      return;
    }

    sendJson(reply, 404, {
      error: "Not found",
    });
  });
}

export async function readIndexHtml(): Promise<string> {
  const indexPath = join(PUBLIC_DIR, "index.html");
  return readFile(indexPath, "utf8");
}

export function getWebRuntimeConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    apiBaseUrl: getApiBaseUrl(env),
    port: getPort(env),
  };
}
