import { Hono } from "hono";
import { cors } from "hono/cors";
import { healthRoutes } from "./routes/health";
import { activityRoutes } from "./routes/activities";
import { trendRoutes } from "./routes/trends";
import { metaRoutes } from "./routes/meta";
import { syncRoutes } from "./routes/sync";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { DurableObject } from "cloudflare:workers";
import { authorized } from "./auth";
import { buildBrief } from "./brief";
import { createMcpServer } from "./mcp";
import { scheduledSync, syncStatus } from "./sync";

export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Workers VPC service for home/proxy.py on via-server. Unset in local dev. */
  GARMIN_HOME?: Fetcher;
  GARMIN_PROXY_URL: string;
  GARMIN_PROXY_TOKEN?: string;
  /** Encrypts the Garmin cookies in D1. */
  SESSION_KEY?: string;
  MCP_BEARER: string;
  SYNC_TOKEN?: string;
  SLACKPIPES_WEBHOOK?: string;
};
export type Env = { Bindings: Bindings };

const app = new Hono<Env>();

app.use("/api/*", cors());

app.route("/api/meta", metaRoutes);
app.route("/api/health", healthRoutes);
app.route("/api/activities", activityRoutes);
app.route("/api/trends", trendRoutes);
app.route("/api/sync", syncRoutes);

// Same paths the via-server FastMCP exposed, behind the MCP bearer token.
app.route("/sync", syncRoutes);

app.all("/mcp", async (c) => {
  if (!(await authorized(c.req.header("Authorization"), c.env.MCP_BEARER))) return c.json({ error: "Unauthorized" }, 401);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await createMcpServer(c.env, c.executionCtx).connect(transport);
  return transport.handleRequest(c.req.raw);
});

// A misconfigured MCP URL (/mcp/, /mcp/sse) must fail loudly, not get the SPA's 200 page.
app.all("/mcp/*", (c) => c.json({ error: "Not found. The MCP endpoint is /mcp" }, 404));

app.get("/brief", async (c) => {
  if (!(await authorized(c.req.header("Authorization"), c.env.MCP_BEARER))) return c.json({ error: "Unauthorized" }, 401);
  return c.json(await buildBrief(c.env.DB, await syncStatus(c.env.DB)));
});

// Fallback to static assets for non-API routes
app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

/** Retired container host: no binding, no container, starts nothing. Deleting the class needs a migration that
 *  can't be rolled back, so it goes in a later deploy (USAGE.md, "Teardown"). */
export class GarminCollector extends DurableObject {
  async alarm() {
    await this.ctx.storage.deleteAlarm();
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Bindings) {
    await scheduledSync(env);
  },
} satisfies ExportedHandler<Bindings>;
