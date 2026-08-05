import type { Context, Next } from "hono";
import { safeEqual } from "./ids";

/** Fail closed: a missing configured token is a misconfiguration (no access).
 *  An absent or non-matching bearer gets 401. */
export function bearerAuth(expectedToken: string) {
  return async (c: Context, next: Next) => {
    if (!expectedToken) {
      return c.json({ error: "server misconfigured: no relay token" }, 500);
    }
    const header = c.req.header("Authorization") ?? "";
    const got = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!got || !safeEqual(got, expectedToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
