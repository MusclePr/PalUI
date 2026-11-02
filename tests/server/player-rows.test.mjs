import assert from "node:assert/strict";
import test from "node:test";
import { buildPlayerRows, reconcilePlayerItems } from "../../app/players/player-rows.ts";

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
  }], ["steam_76561198847285114"], "");

  assert.equal(rows.length, 1);
  assert.equal(rows[0].playerId, "A1B2C3D4");
  assert.equal(rows[0].userId, "steam_76561198847285114");
  assert.equal(rows[0].name, "Old name");
  assert.equal(rows[0].gameName, "Sakura");
  assert.equal(rows[0].accountName, "steam-account");
  assert.equal(rows[0].online, true);
  assert.equal(rows[0].whitelisted, true);
});

test("registered and game names are independently searchable, with ID placeholders falling back to game names", () => {
  const online = { name: "Game name", accountName: "", playerId: "game1", userId: "steam_1", ip: "", ping: 0, buildingCount: 0, level: 1, lastLogin: null, banned: false };
  const registered = { userId: "steam_1", displayName: "Registered name", role: "メンバー", white: true, banned: false, level: 1, lastLogin: null, firstLogin: null };
  for (const search of ["Registered name", "Game name"]) {
    const [row] = buildPlayerRows([online], [registered], ["steam_1"], search);
    assert.equal(row.name, "Registered name");
    assert.equal(row.gameName, "Game name");
  }
  assert.equal(buildPlayerRows([online], [{ ...registered, displayName: "steam_1" }], ["steam_1"], "")[0].name, "Game name");
  assert.equal(buildPlayerRows([online], [], [], "")[0].name, "Game name");
  const [offline] = buildPlayerRows([], [registered], ["steam_1"], "");
  assert.equal(offline.name, "Registered name");
  assert.equal(offline.gameName, "");
});

test("whitelist removals and stored BAN removals override stale true flags", () => {
  const player = { name: "Player", accountName: "", playerId: "game1", userId: "steam_1", ip: "", ping: 0, buildingCount: 0, level: 1, lastLogin: null, banned: true };
  const registered = { userId: "steam_1", displayName: "Player", role: "メンバー", white: true, banned: true, level: 1, lastLogin: null, firstLogin: null };
  assert.equal(buildPlayerRows([player], [registered], ["steam_1"], "")[0].banned, true);
  const [row] = buildPlayerRows([player], [{ ...registered, banned: false }], [], "");
  assert.equal(row.whitelisted, false);
  assert.equal(row.banned, false);
});

test("reconciliation retains unchanged arrays and objects, updating only changed players", () => {
  const current = [{ userId: "steam_1", level: 1 }, { userId: "steam_2", level: 2 }];
  const key = (player) => player.userId;
  assert.equal(reconcilePlayerItems(current, current.map((player) => ({ ...player })), key), current);
  const next = reconcilePlayerItems(current, [{ ...current[0] }, { ...current[1], level: 3 }], key);
  assert.equal(next[0], current[0]);
  assert.notEqual(next[1], current[1]);
  assert.equal(next[1].level, 3);
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