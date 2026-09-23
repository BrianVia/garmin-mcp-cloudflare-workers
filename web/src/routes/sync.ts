import { Hono } from "hono";
import { collector } from "../collector";
import { authorized } from "../auth";
import type { Env } from "../server";

// POST starts a sync (202 started, 409 busy); GET returns sync status.
// Accepts the MCP bearer or the older SYNC_TOKEN.
export const syncRoutes = new Hono<Env>();

syncRoutes.use(async (c, next) => {
  const header = c.req.header("Authorization");
  if (!(await authorized(header, c.env.MCP_BEARER)) && !(await authorized(header, c.env.SYNC_TOKEN))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

syncRoutes.post("/", async (c) => {
  const result = await collector(c.env).startSync(c.req.query("date") ?? null);
  return c.json(result, result.status === "started" ? 202 : 409);
});

syncRoutes.get("/", async (c) => c.json(await collector(c.env).status()));

// Upload a garmin_session.json (Camoufox cookies) when Garmin won't accept a fresh login from Cloudflare.
syncRoutes.put("/session", async (c) => {
  const session = await c.req.json<{ cookies?: unknown[]; saved_at?: number }>();
  if (!Array.isArray(session.cookies) || typeof session.saved_at !== "number") {
    return c.json({ error: "expected garmin_session.json: {cookies: [...], saved_at: <unix seconds>}" }, 400);
  }
  await collector(c.env).setSession({ cookies: session.cookies, saved_at: session.saved_at });
  return c.json({ ok: true, cookies: session.cookies.length });
});
