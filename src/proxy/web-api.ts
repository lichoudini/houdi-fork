import { createServer, type Server } from "node:http";
import { URL } from "node:url";
import { parsePositiveInteger, readHttpRequestBody, writeJsonResponse } from "../local-bridge-http.js";
import { logError, logInfo } from "../logger.js";
import { WebBrowser } from "../web-browser.js";
import { proxyConfig } from "./config.js";

export type ProxyWebApiPlannerContext = {
  baseUrl: string;
  authMode: "none" | "runtime-managed";
};

type ReusableProxyWebApiCheck = {
  ok: boolean;
  reason: string;
};

const PROXY_WEB_API_SERVICE = "proxy-web-api";
const PROXY_WEB_API_META_VERSION = 1;

function errorCodeOf(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

export class ProxyWebApiServer {
  constructor(
    private readonly server: Server | null,
    readonly plannerContext: ProxyWebApiPlannerContext,
  ) {}

  async close(): Promise<void> {
    if (!this.server) {
      return;
    }
    const activeServer = this.server;
    await new Promise<void>((resolve, reject) => {
      activeServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function normalizePlannerHost(hostInput: string): string {
  const host = hostInput.trim();
  if (!host || host === "0.0.0.0" || host === "::" || host === "::0") {
    return "127.0.0.1";
  }
  return host;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

export function buildProxyWebApiBaseUrls(): string[] {
  const out = new Set<string>();
  const plannerHost = normalizePlannerHost(proxyConfig.webApiHost);
  out.add(`http://${plannerHost}:${proxyConfig.webApiPort}`);
  out.add(`http://127.0.0.1:${proxyConfig.webApiPort}`);
  out.add(`http://localhost:${proxyConfig.webApiPort}`);
  return [...out];
}

function commandTargetsProxyWebApi(command: string, baseUrls: string[]): boolean {
  const normalized = stripTrailingSlash(command.trim());
  return baseUrls.some((baseUrl) => {
    const base = stripTrailingSlash(baseUrl);
    return normalized.includes(`${base}/api/`) || normalized.includes(`${base}/web/`);
  });
}

function hasAuthorizationHeader(command: string): boolean {
  return /(?:^|\s)(?:-H|--header)\s+["']?Authorization:/i.test(command);
}

export function rewriteProxyWebApiCurlCommandForRuntime(
  command: string,
  options: {
    bearerToken?: string;
    baseUrls?: string[];
  } = {},
): string {
  const bearerToken = options.bearerToken ?? proxyConfig.webApiToken;
  if (!bearerToken || !/^\s*curl\b/i.test(command)) {
    return command;
  }

  const baseUrls = options.baseUrls ?? buildProxyWebApiBaseUrls();
  if (!commandTargetsProxyWebApi(command, baseUrls) || hasAuthorizationHeader(command)) {
    return command;
  }

  return command.replace(/^\s*curl\b/i, `curl -H "Authorization: Bearer ${bearerToken}"`);
}

function metaPayload(): {
  ok: true;
  service: string;
  metaVersion: number;
  authMode: "none" | "token";
  routes: string[];
} {
  return {
    ok: true,
    service: PROXY_WEB_API_SERVICE,
    metaVersion: PROXY_WEB_API_META_VERSION,
    authMode: proxyConfig.webApiToken ? "token" : "none",
    routes: ["/api/web/search", "/api/web/open", "/api/meta"],
  };
}

export async function validateReusableProxyWebApiEndpoint(params: {
  plannerContext: ProxyWebApiPlannerContext;
  expectedToken?: string;
  timeoutMs?: number;
}): Promise<ReusableProxyWebApiCheck> {
  const timeoutMs = Math.max(250, Math.min(params.timeoutMs ?? 1_500, 5_000));
  const expectedToken = params.expectedToken ?? proxyConfig.webApiToken;
  const metaUrl = `${stripTrailingSlash(params.plannerContext.baseUrl)}/api/meta`;
  const expectedAuthMode = expectedToken ? "token" : "none";

  const fetchJson = async (withAuth: boolean): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(metaUrl, {
        method: "GET",
        headers: withAuth && expectedToken ? { Authorization: `Bearer ${expectedToken}` } : {},
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    if (expectedToken) {
      const unauthorized = await fetchJson(false);
      if (unauthorized.status !== 401) {
        return {
          ok: false,
          reason: `meta auth mismatch (status sin token=${unauthorized.status})`,
        };
      }
    }

    const response = await fetchJson(Boolean(expectedToken));
    if (!response.ok) {
      return {
        ok: false,
        reason: `meta status inválido (${response.status})`,
      };
    }

    const payload = (await response.json()) as {
      ok?: unknown;
      service?: unknown;
      metaVersion?: unknown;
      authMode?: unknown;
    };
    if (payload.ok !== true || payload.service !== PROXY_WEB_API_SERVICE) {
      return {
        ok: false,
        reason: "meta payload no corresponde a proxy-web-api",
      };
    }
    if (payload.metaVersion !== PROXY_WEB_API_META_VERSION) {
      return {
        ok: false,
        reason: `metaVersion incompatible (${String(payload.metaVersion)})`,
      };
    }
    if (payload.authMode !== expectedAuthMode) {
      return {
        ok: false,
        reason: `authMode incompatible (${String(payload.authMode)})`,
      };
    }

    return {
      ok: true,
      reason: "endpoint reutilizable verificado",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `probe falló: ${message}`,
    };
  }
}

function parseSearchQuery(searchParams: URLSearchParams): string {
  const query = searchParams.get("q") ?? searchParams.get("query") ?? "";
  return query.trim();
}

function parseOpenUrl(searchParams: URLSearchParams): string {
  const target = searchParams.get("url") ?? searchParams.get("u") ?? "";
  return target.trim();
}

export async function startProxyWebApiServer(): Promise<ProxyWebApiServer | null> {
  if (!proxyConfig.webApiEnabled) {
    logInfo("Proxy Web API deshabilitada por configuración.");
    return null;
  }

  const browser = new WebBrowser({
    timeoutMs: proxyConfig.webFetchTimeoutMs,
    maxFetchBytes: proxyConfig.webFetchMaxBytes,
    maxTextChars: proxyConfig.webContentMaxChars,
    defaultSearchResults: proxyConfig.webSearchMaxResults,
  });

  const server = createServer(async (req, res) => {
    const method = (req.method ?? "GET").toUpperCase();
    const parsedUrl = new URL(
      req.url ?? "/",
      `http://${normalizePlannerHost(proxyConfig.webApiHost)}:${proxyConfig.webApiPort}`,
    );
    const pathname = parsedUrl.pathname.replace(/\/+$/g, "") || "/";
    const requiresAuth = pathname !== "/health" && pathname !== "/api/health";

    if (requiresAuth && proxyConfig.webApiToken) {
      const authHeader = req.headers.authorization?.trim() || "";
      const expected = `Bearer ${proxyConfig.webApiToken}`;
      if (authHeader !== expected) {
        writeJsonResponse(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
    }

    if (method === "GET" && (pathname === "/health" || pathname === "/api/health")) {
      writeJsonResponse(res, 200, {
        ...metaPayload(),
      });
      return;
    }

    if (method === "GET" && pathname === "/api/meta") {
      writeJsonResponse(res, 200, metaPayload());
      return;
    }

    if (
      (pathname === "/web/search" || pathname === "/api/web/search") &&
      (method === "GET" || method === "POST")
    ) {
      let query = parseSearchQuery(parsedUrl.searchParams);
      let limit = parsePositiveInteger(parsedUrl.searchParams.get("limit"));
      if (method === "POST") {
        try {
          const bodyRaw = await readHttpRequestBody(req, proxyConfig.webApiMaxBodyBytes);
          const bodyParsed = bodyRaw ? (JSON.parse(bodyRaw) as unknown) : {};
          if (bodyParsed && typeof bodyParsed === "object" && !Array.isArray(bodyParsed)) {
            const bodyRecord = bodyParsed as Record<string, unknown>;
            const bodyQuery =
              typeof bodyRecord.q === "string"
                ? bodyRecord.q
                : typeof bodyRecord.query === "string"
                  ? bodyRecord.query
                  : "";
            if (bodyQuery.trim()) {
              query = bodyQuery.trim();
            }
            const bodyLimit = parsePositiveInteger(bodyRecord.limit);
            if (bodyLimit) {
              limit = bodyLimit;
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          writeJsonResponse(res, 400, { ok: false, error: `invalid body: ${message}` });
          return;
        }
      }
      if (!query) {
        writeJsonResponse(res, 400, {
          ok: false,
          error: "query vacío. Usa ?q=... o body {\"query\":\"...\"}.",
        });
        return;
      }
      try {
        const results = await browser.search(query, limit);
        writeJsonResponse(res, 200, {
          ok: true,
          query,
          count: results.length,
          results,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeJsonResponse(res, 502, { ok: false, error: message });
      }
      return;
    }

    if (
      (pathname === "/web/open" || pathname === "/api/web/open") &&
      (method === "GET" || method === "POST")
    ) {
      let targetUrl = parseOpenUrl(parsedUrl.searchParams);
      if (method === "POST") {
        try {
          const bodyRaw = await readHttpRequestBody(req, proxyConfig.webApiMaxBodyBytes);
          const bodyParsed = bodyRaw ? (JSON.parse(bodyRaw) as unknown) : {};
          if (bodyParsed && typeof bodyParsed === "object" && !Array.isArray(bodyParsed)) {
            const bodyRecord = bodyParsed as Record<string, unknown>;
            const bodyUrl =
              typeof bodyRecord.url === "string"
                ? bodyRecord.url
                : typeof bodyRecord.u === "string"
                  ? bodyRecord.u
                  : "";
            if (bodyUrl.trim()) {
              targetUrl = bodyUrl.trim();
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          writeJsonResponse(res, 400, { ok: false, error: `invalid body: ${message}` });
          return;
        }
      }
      if (!targetUrl) {
        writeJsonResponse(res, 400, {
          ok: false,
          error: "url vacía. Usa ?url=... o body {\"url\":\"https://...\"}.",
        });
        return;
      }
      try {
        const page = await browser.open(targetUrl);
        writeJsonResponse(res, 200, {
          ok: true,
          page,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeJsonResponse(res, 502, { ok: false, error: message });
      }
      return;
    }

    writeJsonResponse(res, 404, { ok: false, error: "not_found" });
  });

  const plannerHost = normalizePlannerHost(proxyConfig.webApiHost);
  const plannerContext: ProxyWebApiPlannerContext = {
    baseUrl: `http://${plannerHost}:${proxyConfig.webApiPort}`,
    authMode: proxyConfig.webApiToken ? "runtime-managed" : "none",
  };

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", (error) => reject(error));
      server.listen(proxyConfig.webApiPort, proxyConfig.webApiHost, () => resolve());
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = errorCodeOf(error);
    if (code === "EADDRINUSE" || /EADDRINUSE/.test(message)) {
      const reusable = await validateReusableProxyWebApiEndpoint({ plannerContext });
      if (reusable.ok) {
        logInfo(
          `Proxy Web API ya está ocupando ${proxyConfig.webApiHost}:${proxyConfig.webApiPort}; reutilizando endpoint verificado.`,
        );
        return new ProxyWebApiServer(null, plannerContext);
      }
      logError(
        `Proxy Web API ocupada en ${proxyConfig.webApiHost}:${proxyConfig.webApiPort}, pero el endpoint no pasó validación (${reusable.reason}). Continúo sin Web API local.`,
      );
      return null;
    }
    if (code === "EACCES" || code === "EPERM" || /EACCES|EPERM/.test(message)) {
      logError(
        `Proxy Web API no pudo abrir ${proxyConfig.webApiHost}:${proxyConfig.webApiPort} (${code || "permiso"}). Continúo sin Web API local.`,
      );
      return null;
    }
    throw error;
  }

  logInfo(
    `Proxy Web API activa en ${proxyConfig.webApiHost}:${proxyConfig.webApiPort} (planner: ${plannerContext.baseUrl})`,
  );
  server.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    logError(`Proxy Web API error: ${message}`);
  });

  return new ProxyWebApiServer(server, plannerContext);
}
