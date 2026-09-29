import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { authCookie, isSameOriginRequest, readSession } from "../../lib/server/auth.ts";

function sessionCookie(role = "operator") {
  const payload = Buffer.from(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
  const secret = process.env.AUTH_COOKIE_SECRET || "palui-development-cookie-secret-change-me";
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${authCookie.name}=${payload}.${signature}`;
}

test("API sessions require a valid signed role and expiry", () => {
  const signedSession = sessionCookie().slice(authCookie.name.length + 1);
  assert.equal(readSession(signedSession), "operator");
  assert.equal(readSession("invalid"), null);
  assert.equal(readSession(undefined), null);
});

test("same-origin checks support trusted reverse-proxy forwarding headers", () => {
  const request = new Request("http://palui:3000/api/server/lifecycle", {
    headers: {
      host: "palui:3000",
      origin: "https://pal.example",
      "x-forwarded-host": "pal.example",
      "x-forwarded-proto": "https",
    },
  });
  assert.equal(isSameOriginRequest(request), true);

  const crossOrigin = new Request("http://palui:3000/api/server/lifecycle", {
    headers: {
      host: "palui:3000",
      origin: "https://attacker.example",
      "x-forwarded-host": "pal.example",
      "x-forwarded-proto": "https",
    },
  });
  assert.equal(isSameOriginRequest(crossOrigin), false);
});

test("mutating routes can reject missing sessions and cross-origin requests", () => {
  const missingSession = new Request("http://localhost/api/server/overview", {
    method: "POST",
    headers: { origin: "http://localhost" },
  });
  assert.equal(readSession(undefined), null);
  assert.equal(isSameOriginRequest(missingSession), true);

  const crossOrigin = new Request("http://localhost/api/server/lifecycle", {
    method: "POST",
    headers: { cookie: sessionCookie(), origin: "https://attacker.example" },
  });
  assert.equal(readSession(sessionCookie().slice(authCookie.name.length + 1)), "operator");
  assert.equal(isSameOriginRequest(crossOrigin), false);
});