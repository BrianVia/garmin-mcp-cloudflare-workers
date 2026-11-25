import { Hono } from "hono";
import { z } from "zod";
import { authorized } from "../auth";
import { connectCookies } from "../garmin/client";
import { saveLogin } from "../state";
import { startSync, syncStatus } from "../sync";
import type { Env } from "../server";

// POST starts a sync (202 started, 409 busy); GET returns sync and login status.
// Accepts the MCP bearer or SYNC_TOKEN (the one via-server holds).
export const syncRoutes = new Hono<Env>();

syncRoutes.use(async (c, next) => {
  const header = c.req.header("Authorization");
  if (!(await authorized(header, c.env.MCP_BEARER)) && !(await authorized(header, c.env.SYNC_TOKEN))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

syncRoutes.post("/", async (c) => {
  const date = c.req.query("date") ?? null;
  // The date is put into Garmin URLs and GraphQL queries.
  if (date !== null && !z.iso.date().safeParse(date).success) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
  const result = await startSync(c.env, (sync) => c.executionCtx.waitUntil(sync), date);
  return c.json(result, result.status === "started" ? 202 : 409);
});

syncRoutes.get("/", async (c) => c.json(await syncStatus(c.env.DB)));

const sessionSchema = z.object({
  cookies: z.array(z.object({ name: z.string(), value: z.string(), domain: z.string(), expires: z.number().optional() })).max(200),
  saved_at: z.number(),
});

// Upload a garmin_session.json (browser cookies) after logging in to Garmin; home/login.py does this.
syncRoutes.put("/session", async (c) => {
  const parsed = sessionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "expected garmin_session.json: {cookies: [...], saved_at: <unix seconds>}" }, 400);
  const kept = connectCookies(parsed.data.cookies);
  if (!kept.some((cookie) => cookie.name === "session")) return c.json({ error: "no connect.garmin.com session cookie; log in first" }, 400);
  await saveLogin(c.env, parsed.data);
  return c.json({ ok: true, cookies: kept.length });
});
