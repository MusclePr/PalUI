import assert from "node:assert/strict";
import test from "node:test";
import { buildPlayerRows } from "../../app/players/player-rows.ts";

test("online and registered players merge by userId, preserving both identifiers", () => {
  const rows = buildPlayerRows([{
    name: "Sakura",
    accountName: "steam-account",
    playerId: "A1B2C3D4",
    userId: "steam_76561198847285114",
    ip: "127.0.0.1",
    ping: 20,
    buildingCount: 3,
    level: 10,
    lastLogin: null,
    banned: false,
  }], [{
    userId: "steam_76561198847285114",
    displayName: "Old name",
    role: "メンバー",
    white: true,
    banned: false,
    level: 8,
    lastLogin: null,
    firstLogin: null,
  }], [], "");

  assert.equal(rows.length, 1);
  assert.equal(rows[0].playerId, "A1B2C3D4");
  assert.equal(rows[0].userId, "steam_76561198847285114");
  assert.equal(rows[0].name, "Sakura");
  assert.equal(rows[0].accountName, "steam-account");
  assert.equal(rows[0].online, true);
  assert.equal(rows[0].whitelisted, true);
});

test("online players without userId remain separate from registered users", () => {
  const onlinePlayer = {
    name: "Sakura",
    accountName: "",
    playerId: "A1B2C3D4",
    userId: "",
    ip: "",
    ping: 0,
    buildingCount: 0,
    level: 1,
    lastLogin: null,
    banned: false,
  };
  const registeredPlayer = {
    userId: "steam_76561198847285114",
    displayName: "Sakura",
    role: "メンバー",
    white: true,
    banned: false,
    level: 1,
    lastLogin: null,
    firstLogin: null,
  };

  const rows = buildPlayerRows([onlinePlayer], [registeredPlayer], [], "");

  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.online)?.userId, "");
  assert.equal(rows.find((row) => !row.online)?.userId, registeredPlayer.userId);
});