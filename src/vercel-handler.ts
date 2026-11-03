import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance, HTTPMethods } from "fastify";
import { buildApp } from "./application.js";
import { config } from "./config.js";

const routeKey = "__afi_path";
const maxBodyBytes = 32768;
let application: Promise<FastifyInstance> | undefined;
function getApplication() {
  return (application ??= buildApp().catch((error) => {
    application = undefined;
    throw error;
  }));
}

export function requestUrl(value: string) {
  const url = new URL(value, "http://afi.internal");
  // The rewrite passes the original pathname explicitly; preserve financial query filters.
  const original = url.searchParams.get(routeKey) ?? url.pathname;
  url.searchParams.delete(routeKey);
  if (
    !original.startsWith("/") ||
    original.startsWith("//") ||
    original.includes("\\")
  )
    throw Object.assign(Error("Ruta inválida"), { statusCode: 400 });
  const query = url.searchParams.toString();
  return original + (query ? "?" + query : "");
}

async function payload(req: IncomingMessage & { body?: unknown }) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS")
    return undefined;
  if (req.body !== undefined) {
    const value = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(
          typeof req.body === "string" ? req.body : JSON.stringify(req.body),
        );
    if (value.length > maxBodyBytes)
      throw Object.assign(Error("El formulario excede el límite permitido"), {
        statusCode: 413,
      });
    return value;
  }
  // Vercel may provide a parsed request without a readable stream for empty POSTs.
  // Logout and notification refresh have no body; do not try to iterate that stream.
  if (
    !req.headers["transfer-encoding"] &&
    (!req.headers["content-length"] || req.headers["content-length"] === "0")
  )
    return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > maxBodyBytes)
      throw Object.assign(Error("El formulario excede el límite permitido"), {
        statusCode: 413,
      });
    chunks.push(chunk);
  }
  return size ? Buffer.concat(chunks) : undefined;
}

// Vercel owns the HTTP listener. This entrypoint never imports server.ts or calls listen().
export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
) {
  try {
    const app = await getApplication();
    const body = await payload(req);
    const headers = { ...req.headers };
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    const result = await app.inject({
      method: (req.method ?? "GET") as HTTPMethods,
      url: requestUrl(req.url ?? "/"),
      headers,
      payload: body,
      remoteAddress: req.socket?.remoteAddress ?? "127.0.0.1",
    });
    res.statusCode = result.statusCode;
    for (const [name, value] of Object.entries(result.headers))
      if (value !== undefined) res.setHeader(name, value);
    res.end(result.rawPayload);
  } catch (error) {
    const e = error as Error & { statusCode?: number };
    const status = e.statusCode ?? 503;
    if (status >= 500)
      console.error("AFIBACK initialization/request failed", e);
    const origin = req.headers.origin;
    if (
      typeof origin === "string" &&
      config.FRONTEND_URL.split(",").includes(origin)
    ) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(
      JSON.stringify({
        error: {
          code: status === 503 ? "BACKEND_UNAVAILABLE" : "REQUEST_ERROR",
          message:
            status >= 500
              ? "El backend no pudo iniciar. Revisa los registros del servidor."
              : e.message,
        },
      }),
    );
  }
}
