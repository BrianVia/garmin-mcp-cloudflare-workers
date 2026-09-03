import { Hono, type Context } from "hono";
import type { Env } from "../server";

// Wrangler secrets: SYNC_URL, SYNC_TOKEN.
export const syncRoutes = new Hono<Env>();

async function proxy(c: Context<Env>) {
  const { SYNC_URL, SYNC_TOKEN } = c.env;
  if (!SYNC_URL || !SYNC_TOKEN) {
    return c.json({ error: "SYNC_URL/SYNC_TOKEN not configured" }, 501);
  }
  if (c.req.header("Authorization") !== `Bearer ${SYNC_TOKEN}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const response = await fetch(`${SYNC_URL}/sync`, {
    method: c.req.method,
    headers: { Authorization: `Bearer ${SYNC_TOKEN}` },
  });
  return new Response(response.body, {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
}

syncRoutes.post("/", proxy);
syncRoutes.get("/", proxy);
