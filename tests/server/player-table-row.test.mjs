import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import ts from "typescript";
import { buildPlayerRows } from "../../app/players/player-rows.ts";

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".tsx")) {
      return {
        format: "module",
        shortCircuit: true,
        source: ts.transpile(readFileSync(fileURLToPath(url), "utf8"), {
          module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
        }),
      };
    }
    return nextLoad(url, context);
  },
});

const { PlayerTableRow } = await import("../../app/players/PlayerTableRow.tsx");
const player = { name: "Game name", accountName: "", playerId: "game1", userId: "steam_1", ip: "", ping: 0, buildingCount: 0, level: 1, lastLogin: null, banned: false };
const registered = { userId: "steam_1", displayName: "Registered name", role: "メンバー", white: true, banned: false, level: 1, lastLogin: null, firstLogin: null };
function render(online, displayName, lastLogin = null) {
  const [row] = buildPlayerRows(online, [{ ...registered, displayName, lastLogin }], ["steam_1"], "");
  return renderToStaticMarkup(createElement(PlayerTableRow, {
    ...row, menuOpen: false, onToggleMenu() {}, onCopyId() {}, async onToggleWhitelist() {}, onDelete() {},
  }));
}

test("registered name remains primary and distinct game name appears beside it with the correct tooltip", () => {
  const html = render([player], "Registered name");
  assert.match(html, /<strong>Registered name<\/strong><small class="muted">（ゲーム内名: Game name）<\/small>/);
  assert.match(html, /title="ゲーム内名: Game name/);
});

test("matching, ID-placeholder, and offline names do not show redundant game-name supplements", () => {
  for (const [online, name] of [[[player], "Game name"], [[player], "steam_1"], [[], "Registered name"]]) {
    assert.doesNotMatch(render(online, name), /<small/);
  }
});

test("offline rows display the persisted last-login timestamp in the browser's local timezone", () => {
  const timestamp = "2026-01-05T00:00:15.000Z";
  const html = render([], "Registered name", timestamp);
  assert.ok(html.includes("オフライン"));
  assert.ok(html.includes(`<td>${new Date(timestamp).toLocaleString("ja-JP")}</td>`));
});
