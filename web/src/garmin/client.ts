// Garmin Connect REST client. Every request leaves from the home IP through home/proxy.py on via-server.
import { ACTIVITY_LIST, type Endpoint } from "./endpoints";

export type Cookie = { name: string; value: string; domain: string; expires?: number; [key: string]: unknown };
export type Session = { cookies: Cookie[]; saved_at: number };

/** `session_expired`: log in again. `blocked`: Garmin rate limit or challenge; logging in again makes it worse.
 *  `home_down`: via-server, its tunnel or the proxy is unreachable. `garmin`: Garmin itself failed. */
export type FailureMode = "session_expired" | "blocked" | "home_down" | "garmin";

export class GarminError extends Error {
  constructor(readonly mode: FailureMode, message: string) {
    super(message);
  }
}

export type Home = { fetch: (url: string, init: RequestInit) => Promise<Response>; url: string; token: string };
export type Fetched = { endpoint: Endpoint; data: unknown };

const HOST = "connect.garmin.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0";
const REQUEST_TIMEOUT_MS = 20_000; // longer than the proxy's own 15 s, so a slow Garmin isn't mistaken for a dead proxy
const CONCURRENCY = 6; // Workers open at most six connections at once
// No separators or control characters: these go into a Cookie header.
const COOKIE_PART = /^[\x21-\x3a\x3c-\x7e]+$/;
const CSRF = /name="(?:csrf-token|_csrf)"[^>]*content="([^"]+)"/;

const appliesToConnect = (domain: string) => {
  const bare = domain.replace(/^\./, "");
  return HOST === bare || HOST.endsWith(`.${bare}`);
};

/** The cookies the Worker needs. Garmin's SSO cookies, which can mint new logins, stay on via-server. */
export const connectCookies = (cookies: Cookie[]) =>
  cookies.filter((c) => appliesToConnect(c.domain) && !c.name.startsWith("ADRUM_") && COOKIE_PART.test(c.name) && COOKIE_PART.test(c.value));

/** When Garmin will stop accepting these cookies, in unix ms. */
export function sessionExpiry(cookies: Cookie[]): number | null {
  const expires = cookies.find((c) => c.name === "session")?.expires;
  return expires && expires > 0 ? Math.round(expires * 1000) : null;
}

export class GarminClient {
  /** True once Garmin has replaced the long-lived `session` cookie. */
  sessionRotated = false;
  /** Set when a failure made the rest of the sync pointless; results fetched before it are still good. */
  fatal: GarminError | null = null;
  readonly failed: string[] = [];
  displayName = "";
  private cookies: Map<string, Cookie>;
  private csrf = "";

  constructor(private readonly home: Home, session: Session, private readonly retryDelayMs = 1_000) {
    this.cookies = new Map(connectCookies(session.cookies).map((c) => [c.name, c]));
  }

  currentCookies(): Cookie[] {
    return [...this.cookies.values()];
  }

  /** Load the app page for its CSRF token, then prove the session works. */
  async connect(): Promise<void> {
    const page = await this.withRetry(() => this.send("/app/home", { accept: "text/html" }));
    if (page.status >= 300 && page.status < 400) throw new GarminError("session_expired", "Garmin redirected to sign-in");
    const csrf = page.status === 200 ? CSRF.exec(await page.text())?.[1] : undefined;
    if (!csrf) throw new GarminError(page.status === 401 || page.status === 403 ? "session_expired" : "garmin", `no CSRF token on the app page (HTTP ${page.status})`);
    this.csrf = csrf;

    const res = await this.withRetry(() => this.send("/gc-api/userprofile-service/socialProfile"));
    if (res.status === 401 || res.status === 403) throw new GarminError("session_expired", `profile returned HTTP ${res.status}`);
    if (res.status !== 200) throw new GarminError("garmin", `profile returned HTTP ${res.status}`);
    const name = (await res.json<{ displayName?: unknown }>()).displayName;
    // The name is put into URLs and GraphQL queries.
    if (typeof name !== "string" || !/^[\w.@-]+$/.test(name)) throw new GarminError("garmin", "profile has no usable displayName");
    this.displayName = name;
  }

  /** Fetch endpoints in parallel, returned in the order given. Endpoints with no data are left out;
   *  ones that failed are named in `failed`. Stops early on `fatal`. */
  async fetchAll(endpoints: Endpoint[]): Promise<Fetched[]> {
    const results: (unknown | undefined)[] = new Array(endpoints.length);
    let next = 0;
    const worker = async () => {
      while (next < endpoints.length && !this.fatal) {
        const i = next++;
        const endpoint = endpoints[i]!;
        try {
          results[i] = await this.fetchOne(endpoint);
        } catch (error) {
          this.failed.push(endpoint.date ? `${endpoint.name} ${endpoint.date}` : endpoint.name);
          if (error instanceof GarminError && error.mode !== "garmin") this.fatal ??= error;
          else console.warn(`${endpoint.name} failed`, error);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return endpoints.flatMap((endpoint, i) => (results[i] ? [{ endpoint, data: results[i] }] : []));
  }

  async activities(): Promise<Record<string, any>[]> {
    const [list] = await this.fetchAll([{ name: "activities", path: ACTIVITY_LIST }]);
    return Array.isArray(list?.data) ? list.data : [];
  }

  private async fetchOne(endpoint: Endpoint): Promise<unknown> {
    return this.withRetry(async () => {
      const res = await this.send(endpoint.path, endpoint.body ? { "content-type": "application/json" } : {}, endpoint.body);
      if (res.status === 200) {
        const text = await res.text();
        try {
          return text ? JSON.parse(text) : undefined;
        } catch {
          return text;
        }
      }
      await res.body?.cancel();
      if (res.status === 401) throw new GarminError("session_expired", `${endpoint.name} returned HTTP 401`);
      if (res.status === 403 || res.status >= 500) throw new GarminError("garmin", `${endpoint.name} returned HTTP ${res.status}`);
      return undefined; // 204, 400, 404: this account has no such data
    });
  }

  private async withRetry<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof GarminError && (error.mode === "session_expired" || error.mode === "blocked")) throw error;
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      return run();
    }
  }

  private async send(path: string, headers: Record<string, string> = {}, body?: string): Promise<Response> {
    let res: Response;
    try {
      res = await this.home.fetch(this.home.url + path, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${this.home.token}`,
          accept: "application/json",
          "user-agent": USER_AGENT,
          // Garmin answers 403 without this.
          "sec-fetch-site": "same-origin",
          cookie: this.currentCookies().map((c) => `${c.name}=${c.value}`).join("; "),
          ...(this.csrf && { "connect-csrf-token": this.csrf }),
          ...headers,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new GarminError("home_down", `home proxy unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Only our proxy sets this header, so without it the reply came from the tunnel or something in between.
    const origin = res.headers.get("x-garmin-proxy");
    if (origin !== "garmin") {
      const detail = (await res.text()).slice(0, 200);
      if (origin === "upstream-error") throw new GarminError("garmin", `home proxy could not reach Garmin: ${detail}`);
      throw new GarminError("home_down", `home proxy ${origin ?? "not reached"}: HTTP ${res.status} ${detail}`);
    }
    if (res.status === 427 || res.status === 429 || res.headers.get("cf-mitigated")) {
      await res.body?.cancel();
      throw new GarminError("blocked", `Garmin blocked the request: HTTP ${res.status}`);
    }
    if (res.status === 403) {
      const text = await res.clone().text();
      if (/error code: 10\d\d/.test(text)) throw new GarminError("blocked", `Garmin blocked the request: ${text.trim().slice(0, 100)}`);
    }
    if (res.status === 200) this.absorb(res);
    return res;
  }

  private absorb(res: Response) {
    for (const header of res.headers.getSetCookie()) {
      const [pair = "", ...attributes] = header.split(";");
      const split = pair.indexOf("=");
      const name = pair.slice(0, split).trim();
      const value = pair.slice(split + 1).trim();
      const attribute = (key: string) =>
        attributes.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith(`${key}=`))?.slice(key.length + 1);
      const maxAge = attribute("max-age");
      const until = maxAge !== undefined ? Date.now() / 1000 + Number(maxAge) : Date.parse(attribute("expires") ?? "") / 1000;
      if (split < 1 || name.startsWith("ADRUM_") || !value || until <= Date.now() / 1000) continue;
      if (name === "session" && value !== this.cookies.get("session")?.value) this.sessionRotated = true;
      this.cookies.set(name, { name, value, domain: ".connect.garmin.com", expires: Number.isNaN(until) ? -1 : until });
    }
  }
}
