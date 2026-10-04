import { Hono } from "hono";
import { cors } from "hono/cors";
import { healthRoutes } from "./routes/health";
import { activityRoutes } from "./routes/activities";
import { trendRoutes } from "./routes/trends";
import { metaRoutes } from "./routes/meta";
import { syncRoutes } from "./routes/sync";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { GarminCollector, collector } from "./collector";
import { authorized } from "./auth";
import { buildBrief } from "./brief";
import { createMcpServer } from "./mcp";

export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  COLLECTOR: DurableObjectNamespace<GarminCollector>;
  GARMIN_EMAIL: string;
  GARMIN_PASSWORD: string;
  MCP_BEARER: string;
  SYNC_TOKEN?: string;
  SLACKPIPES_WEBHOOK?: string;
  /** Tailscale OAuth client secret; routes the collector through via-server (entrypoint.sh). */
  TS_AUTHKEY?: string;
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
  await createMcpServer(c.env).connect(transport);
  return transport.handleRequest(c.req.raw);
});

app.get("/brief", async (c) => {
  if (!(await authorized(c.req.header("Authorization"), c.env.MCP_BEARER))) return c.json({ error: "Unauthorized" }, 401);
  return c.json(await buildBrief(c.env.DB, await collector(c.env).inProgress()));
});

// Fallback to static assets for non-API routes
app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export { GarminCollector };
export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Bindings) {
    const result = await collector(env).startSync();
    console.log(`scheduled sync: ${result.status}`);
  },
} satisfies ExportedHandler<Bindings>;
