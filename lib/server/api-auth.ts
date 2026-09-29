import { authCookie, readSession, type AuthRole } from "./auth";
export { isSameOriginRequest } from "./auth";

export function readApiRole(request: Request): AuthRole | null {
  const escapedCookieName = authCookie.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const session = request.headers.get("cookie")?.match(new RegExp(`(?:^|; )${escapedCookieName}=([^;]+)`))?.[1];
  return readSession(session);
}
