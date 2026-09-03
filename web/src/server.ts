import { Hono } from "hono";
import { cors } from "hono/cors";
import { healthRoutes } from "./routes/health";
import { activityRoutes } from "./routes/activities";
import { trendRoutes } from "./routes/trends";
import { metaRoutes } from "./routes/meta";
import { syncRoutes } from "./routes/sync";

export type Env = {
  Bindings: {
    DB: D1Database;
    ASSETS: Fetcher;
    SYNC_URL?: string;
    SYNC_TOKEN?: string;
  };
};

const app = new Hono<Env>();

app.use("/api/*", cors());

app.route("/api/meta", metaRoutes);
app.route("/api/health", healthRoutes);
app.route("/api/activities", activityRoutes);
app.route("/api/trends", trendRoutes);
app.route("/api/sync", syncRoutes);

// Fallback to static assets for non-API routes
app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
