import { expect, test } from "bun:test";
import { GarminClient } from "../src/garmin/client";
import { SESSION, garmin, type Reply } from "./helpers";

const client = (override?: Parameters<typeof garmin>[0]) => {
  const server = garmin(override);
  return { server, client: new GarminClient(server.home, SESSION, 0) };
};
const mode = (promise: Promise<unknown>) => promise.then(() => "ok", (error) => error.mode);
const home = (reply: Reply | Error) => (path: string) => (path === "/app/home" ? reply : undefined);

test("sends Garmin only the cookies it needs, never the SSO ones", async () => {
  const { client: c, server } = client();
  await c.connect();
  expect(c.displayName).toBe("dn-1");
  for (const { init } of server.requests) {
    const headers = init.headers as Record<string, string>;
    expect(headers.cookie).toBe("session=app-session; GARMIN-SSO-CUST-GUID=guid");
    expect(headers["sec-fetch-site"]).toBe("same-origin");
  }
  expect((server.requests.at(-1)!.init.headers as Record<string, string>)["connect-csrf-token"]).toBe("tok");
});

test("tells the failure modes apart", async () => {
  const proxy = (origin: string): [string, string][] => [["x-garmin-proxy", origin]];
  expect(await mode(client(home({ status: 302, headers: [["location", "/signin/"]] })).client.connect())).toBe("session_expired");
  expect(await mode(client((p) => (p.endsWith("socialProfile") ? { status: 403 } : undefined)).client.connect())).toBe("session_expired");
  expect(await mode(client(home({ status: 427 })).client.connect())).toBe("blocked");
  expect(await mode(client(home({ status: 403, body: "error code: 1015" })).client.connect())).toBe("blocked");
  expect(await mode(client(home({ status: 403, headers: [["cf-mitigated", "challenge"]] })).client.connect())).toBe("blocked");
  expect(await mode(client(home(new Error("connection refused"))).client.connect())).toBe("home_down");
  expect(await mode(client(home({ status: 502 })).client.connect())).toBe("garmin");

  // A reply that did not come from Garmin must never look like an expired session.
  for (const [origin, expected] of [["refused", "home_down"], ["upstream-error", "garmin"], ["", "home_down"]] as const) {
    const fetch = async () => new Response("x", { status: 401, headers: origin ? proxy(origin) : [] });
    expect(await mode(new GarminClient({ fetch, url: "", token: "" }, SESSION, 0).connect())).toBe(expected);
  }
});

test("a display name that could alter a URL or query is refused", async () => {
  const c = client((p) => (p.endsWith("socialProfile") ? { body: { displayName: 'x")}' } } : undefined)).client;
  expect(await mode(c.connect())).toBe("garmin");
});

test("retries a transient failure once, and stops early once blocked", async () => {
  let tries = 0;
  const flaky = client((p) => (p === "/flaky" && ++tries === 1 ? { status: 500 } : p === "/flaky" ? { body: { a: 1 } } : undefined)).client;
  expect(await flaky.fetchAll([{ name: "flaky", path: "/flaky" }])).toHaveLength(1);
  expect(flaky.failed).toEqual([]);

  const blocked = client((p) => (p === "/0" ? { body: { a: 1 } } : { status: 429 }));
  const endpoints = Array.from({ length: 50 }, (_, i) => ({ name: `e${i}`, path: `/${i}` }));
  expect(await blocked.client.fetchAll(endpoints)).toHaveLength(1);
  expect(blocked.client.fatal?.mode).toBe("blocked");
  expect(blocked.server.requests.length).toBeLessThan(15);
});

test("keeps a rotated session cookie and ignores cleared ones", async () => {
  const c = client(
    home({
      body: '<meta name="csrf-token" content="tok"/>',
      headers: [["set-cookie", "session=new; Max-Age=7200; Path=/"], ["set-cookie", "GARMIN-SSO-CUST-GUID=; Max-Age=0"]],
    }),
  ).client;
  await c.connect();
  expect(c.sessionRotated).toBe(true);
  expect(Object.fromEntries(c.currentCookies().map((x) => [x.name, x.value]))).toMatchObject({ session: "new", "GARMIN-SSO-CUST-GUID": "guid" });
});
