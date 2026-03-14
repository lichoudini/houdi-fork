import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { rewriteProxyWebApiCurlCommandForRuntime, validateReusableProxyWebApiEndpoint } from "./web-api.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No pude obtener puerto temporal del test server");
  }
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

test("injects auth header for local proxy web api curl commands", () => {
  const command = 'curl -sS "http://127.0.0.1:3222/api/web/search?q=ia&limit=3"';
  const rewritten = rewriteProxyWebApiCurlCommandForRuntime(command, {
    bearerToken: "secret-token",
    baseUrls: ["http://127.0.0.1:3222"],
  });

  assert.match(rewritten, /Authorization: Bearer secret-token/);
  assert.match(rewritten, /api\/web\/search/);
});

test("does not double inject auth header when curl already has authorization", () => {
  const command =
    'curl -sS -H "Authorization: Bearer existing" "http://127.0.0.1:3222/api/web/search?q=ia&limit=3"';
  const rewritten = rewriteProxyWebApiCurlCommandForRuntime(command, {
    bearerToken: "secret-token",
    baseUrls: ["http://127.0.0.1:3222"],
  });

  assert.equal(rewritten, command);
});

test("validates reusable proxy web api endpoint with token auth", async () => {
  const expectedToken = "shared-secret";
  const server = createServer((req, res) => {
    if (req.url !== "/api/meta") {
      res.writeHead(404).end();
      return;
    }
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${expectedToken}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "proxy-web-api",
        metaVersion: 1,
        authMode: "token",
        routes: ["/api/web/search", "/api/web/open", "/api/meta"],
      }),
    );
  });

  const port = await listen(server);
  try {
    const verdict = await validateReusableProxyWebApiEndpoint({
      plannerContext: {
        baseUrl: `http://127.0.0.1:${port}`,
        authMode: "runtime-managed",
      },
      expectedToken,
      timeoutMs: 800,
    });
    assert.deepEqual(verdict, {
      ok: true,
      reason: "endpoint reutilizable verificado",
    });
  } finally {
    await close(server);
  }
});

test("rejects incompatible occupied endpoint", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "otro-servicio", metaVersion: 1, authMode: "none" }));
  });

  const port = await listen(server);
  try {
    const verdict = await validateReusableProxyWebApiEndpoint({
      plannerContext: {
        baseUrl: `http://127.0.0.1:${port}`,
        authMode: "none",
      },
      expectedToken: "",
      timeoutMs: 800,
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /no corresponde a proxy-web-api/);
  } finally {
    await close(server);
  }
});
