import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import ts from "typescript";

const executeFile = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "palui-player-monitor-"));
const previousDirectory = process.env.PALUI_SERVER_DIR;
process.env.PALUI_SERVER_DIR = directory;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".ts")) {
      return { format: "module", shortCircuit: true, source: ts.transpile(readFileSync(fileURLToPath(url), "utf8"), { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }) };
    }
    return nextLoad(url, context);
  },
});

const { readCachedProxyPlayers, readPlayerMonitorContainer } = await import("../../lib/server/compose.ts");
const { parseProxyPlayers, readPlayersCache, withPlayersLock } = await import("../../lib/server/players-cache.ts");
const { addRegisteredPlayer, readPlayers, synchronizePlayers } = await import("../../lib/server/palworld.ts");
const { createPlayersMonitor, startPlayersMonitor } = await import("../../lib/server/players-monitor.ts");
const player = (id = "1", level = 10) => ({ name: `Player ${id}`, accountName: "Account", playerId: `game${id}`, userId: `steam_${id}`, ip: "127.0.0.1", ping: 20, building_count: 3, level });
const normalized = (...players) => parseProxyPlayers({ players });

test("Proxy requests use container credentials and only-if-cached, including while AUTO PAUSE is active", async () => {
  const bin = join(directory, "bin");
  await mkdir(bin);
  await mkdir(join(directory, "palworld"));
  await writeFile(join(directory, "palworld/.paused"), "");
  const argumentsFile = join(directory, "curl-arguments");
  await writeFile(join(bin, "curl"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$ARGUMENTS_FILE"\nprintf \'{"players":[]}\\n200\'\n');
  await chmod(join(bin, "curl"), 0o755);
  let command;
  const execute = async (args, timeout) => {
    command = args;
    assert.equal(timeout, 8_000);
    return executeFile("sh", ["-ec", args.at(-1)], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ADMIN_PASSWORD: "test-password", ARGUMENTS_FILE: argumentsFile },
    });
  };
  assert.deepEqual(await readCachedProxyPlayers(execute), { players: [] });
  assert.deepEqual(command.slice(0, -1), ["exec", "-T", "-u", "steam", "pal", "sh", "-ec"]);
  const argumentsText = await readFile(argumentsFile, "utf8");
  assert.match(argumentsText, /Cache-Control: only-if-cached/);
  assert.match(argumentsText, /http:\/\/127\.0\.0\.1:8213\/v1\/api\/players/);
  assert.match(argumentsText, /admin:test-password/);
  assert.doesNotMatch(command.join(" "), /test-password|rest-cli|autopause resume/);
  for (const port of ["8212", "0", "65536", "invalid"]) {
    await assert.rejects(readCachedProxyPlayers((args) => executeFile("sh", ["-ec", args.at(-1)], {
      env: { ...process.env, API_PROXY_PORT: port, ADMIN_PASSWORD: "test-password" },
    })));
  }
  await assert.rejects(readCachedProxyPlayers((args) => executeFile("sh", ["-ec", args.at(-1)], {
    env: { ...process.env, API_PROXY_ENABLED: "false" },
  })));
  await rm(join(directory, "palworld/.paused"));
});

test("504 is a cache miss, not an empty list; all other HTTP or JSON failures are explicit", async () => {
  let calls = 0;
  assert.equal(await readCachedProxyPlayers(async () => { calls++; return { stdout: "cache missing\n504", stderr: "" }; }), null);
  assert.equal(calls, 1);
  for (const status of ["401", "500", "302"]) {
    await assert.rejects(readCachedProxyPlayers(async () => ({ stdout: `{}\n${status}`, stderr: "" })), new RegExp(status));
  }
  await assert.rejects(readCachedProxyPlayers(async () => ({ stdout: "invalid\n200", stderr: "" })));
  assert.deepEqual(parseProxyPlayers({ players: [] }), []);
  for (const invalid of [{}, { players: null }, { players: [{}] }, { players: [player(), player()] }, { players: [{ ...player(), level: "bad" }] }]) {
    assert.throws(() => parseProxyPlayers(invalid));
  }
});

test("lightweight state lookup does not poll absent or stopped containers and rejects unknown data", async () => {
  const execute = (stdout) => async (args) => {
    assert.deepEqual(args, ["ps", "--all", "--format", "json", "pal"]);
    return { stdout, stderr: "" };
  };
  assert.equal((await readPlayerMonitorContainer(execute(""))).state, "stopped");
  assert.equal((await readPlayerMonitorContainer(execute('[{"ID":"id","State":"exited"}]'))).state, "stopped");
  assert.deepEqual(await readPlayerMonitorContainer(execute('{"ID":"id","State":"running"}')), { state: "running", id: "id" });
  for (const contents of ["not json", "{}", '[{"State":"unknown"}]', '[{"State":"running"}]']) {
    await assert.rejects(readPlayerMonitorContainer(execute(contents)));
  }
});

test("monitor maintains successful baselines across cache misses and failures, resets them on stop/recreation, and prevents overlap", async () => {
  let container = { state: "running", id: "one" };
  let response = { players: [player()] };
  let fetches = 0;
  const updates = [];
  const failures = [];
  let gate;
  const tick = createPlayersMonitor({
    readContainer: async () => container,
    fetchPlayers: async () => { fetches++; if (gate) await gate; return response; },
    synchronize: async (...args) => { updates.push(args); },
    reportError: async (error) => { failures.push(error); },
  });
  await tick();
  assert.equal(updates[0][1], null);
  response = null;
  await tick();
  assert.equal(updates.at(-1)[0], null);
  response = {};
  await tick();
  assert.equal(failures.length, 1);
  response = { players: [] };
  await tick();
  assert.equal(updates.at(-1)[1][0].userId, "steam_1");
  container = { state: "stopped", id: null };
  const beforeStop = fetches;
  await tick();
  assert.equal(fetches, beforeStop);
  assert.deepEqual(updates.at(-1).slice(0, 2), [[], null]);
  container = { state: "running", id: "two" };
  response = { players: [player()] };
  await tick();
  assert.equal(updates.at(-1)[1], null);
  container = { state: "running", id: "three" };
  await tick();
  assert.equal(updates.at(-1)[1], null);
  let release;
  gate = new Promise((resolve) => { release = resolve; });
  const pending = tick();
  await new Promise((resolve) => setImmediate(resolve));
  const during = fetches;
  await tick();
  assert.equal(fetches, during);
  release();
  await pending;
});

test("registered history changes only on logout; snapshots are shared and unchanged data is not rewritten", async () => {
  const registered = { userId: "steam_1", displayName: "Custom name", role: "管理者", white: true, banned: true, level: 1, firstLogin: "2025-01-01T00:00:00.000Z", lastLogin: null };
  await writeFile(join(directory, "players.json"), JSON.stringify([registered]));
  const whitelistDirectory = join(directory, "palworld/Pal/Binaries/Win64/PalDefender");
  await mkdir(whitelistDirectory, { recursive: true });
  await writeFile(join(whitelistDirectory, "WhiteList.json"), '["steam_1"]');
  const first = normalized(player(), player("2"));
  await synchronizePlayers(first, null, "2026-01-01T00:00:00.000Z");
  let saved = JSON.parse(await readFile(join(directory, "players.json"), "utf8"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].lastLogin, null);
  assert.equal(saved[0].level, 10);
  assert.equal(saved[0].displayName, registered.displayName);
  assert.equal(saved[0].role, registered.role);
  const before = await stat(join(directory, ".players-cache.json"));
  const beforeStore = await stat(join(directory, "players.json"));
  await synchronizePlayers(normalized(player("2"), player()), first, "2026-01-01T00:00:05.000Z");
  assert.equal((await stat(join(directory, ".players-cache.json"))).mtimeMs, before.mtimeMs);
  assert.equal((await stat(join(directory, "players.json"))).mtimeMs, beforeStore.mtimeMs);
  await synchronizePlayers(null, first, "2026-01-01T00:00:10.000Z");
  assert.deepEqual((await readPlayersCache()).onlinePlayers, first);
  saved[0].banned = false;
  await writeFile(join(directory, "players.json"), JSON.stringify(saved));
  await writeFile(join(whitelistDirectory, "WhiteList.json"), "[]");
  const localChanges = await readPlayers();
  assert.equal(localChanges.registeredPlayers[0].banned, false);
  assert.deepEqual(localChanges.whitelist, []);
  await synchronizePlayers([], first, "2026-01-01T00:00:15.000Z");
  saved = JSON.parse(await readFile(join(directory, "players.json"), "utf8"));
  assert.equal(saved[0].lastLogin, "2026-01-01T00:00:15.000Z");
  await synchronizePlayers([], [], "2026-01-01T00:00:20.000Z");
  assert.equal((await readPlayers()).registeredPlayers[0].lastLogin, saved[0].lastLogin);
  await synchronizePlayers(first, [], "2026-01-01T00:00:25.000Z");
  await synchronizePlayers([], null, "2026-01-01T00:00:30.000Z");
  assert.equal((await readPlayers()).registeredPlayers[0].lastLogin, saved[0].lastLogin);
  await synchronizePlayers([], null, "2026-01-01T00:00:35.000Z");
  assert.equal((await readPlayers()).registeredPlayers[0].lastLogin, saved[0].lastLogin);
  await writeFile(join(whitelistDirectory, "WhiteList.json"), "{bad");
  await assert.rejects(readPlayers());
  await writeFile(join(whitelistDirectory, "WhiteList.json"), "[]");
});

test("monitor updates and concurrent registrations serialize without losing stored metadata", async () => {
  await Promise.all([
    addRegisteredPlayer({ userId: "steam_3", displayName: "Three", enabled: false }),
    synchronizePlayers(normalized(player("1", 25)), null, "2026-01-02T00:00:00.000Z"),
    addRegisteredPlayer({ userId: "steam_4", displayName: "Four", enabled: false }),
  ]);
  const saved = (await readPlayers()).registeredPlayers;
  assert.equal(saved.find((entry) => entry.userId === "steam_1").level, 25);
  assert.equal(saved.find((entry) => entry.userId === "steam_3").lastLogin, null);
  assert.equal(saved.find((entry) => entry.userId === "steam_4").displayName, "Four");
  const events = [];
  let markAcquired;
  const acquired = new Promise((resolve) => { markAcquired = resolve; });
  await Promise.all([
    withPlayersLock(async () => { events.push("start"); markAcquired(); await new Promise((resolve) => setTimeout(resolve, 10)); events.push("end"); }),
    acquired.then(() => withPlayersLock(async () => { events.push("next"); })),
  ]);
  assert.deepEqual(events, ["start", "end", "next"]);
});

test("startup polls immediately and every five seconds without browser requests or duplicate timers", async () => {
  const calls = [];
  const tick = async () => { calls.push(Date.now()); };
  startPlayersMonitor(tick);
  const timer = globalThis.paluiPlayersMonitor;
  try {
    startPlayersMonitor(tick);
    assert.equal(globalThis.paluiPlayersMonitor, timer);
    assert.equal(calls.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    assert.equal(calls.length, 2);
    assert.ok(calls[1] - calls[0] >= 4_950);
  } finally {
    clearInterval(timer);
    delete globalThis.paluiPlayersMonitor;
  }
});

test("partial persistence retries the same observation and logout timestamp before fetching again", async () => {
  const updates = [];
  let fetches = 0;
  let rejectNext = false;
  let response = { players: [player()] };
  const tick = createPlayersMonitor({
    readContainer: async () => ({ state: "running", id: "one" }),
    fetchPlayers: async () => { fetches++; return response; },
    synchronize: async (...args) => {
      updates.push(args);
      if (rejectNext) { rejectNext = false; throw new Error("cache write failed"); }
    },
    reportError: async () => {},
  });
  await tick();
  response = { players: [] };
  rejectNext = true;
  await tick();
  const failed = updates.at(-1);
  assert.equal(fetches, 2);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await tick();
  assert.deepEqual(updates.at(-2), failed);
  assert.deepEqual(updates.at(-1)[1], []);
  assert.equal(fetches, 3);
});

test("invalid saved snapshots fail explicitly and a valid observation repairs them", async () => {
  await writeFile(join(directory, ".players-cache.json"), "{bad");
  await assert.rejects(readPlayersCache());
  await assert.rejects(synchronizePlayers(null, null, "2026-01-03T00:00:00.000Z"));
  await synchronizePlayers(normalized(player()), null, "2026-01-03T00:00:05.000Z");
  assert.equal((await readPlayersCache()).onlinePlayers[0].userId, "steam_1");
});

test("whitelisted ID placeholders acquire game names without replacing custom or non-whitelisted names", async () => {
  const whitelistFile = join(directory, "palworld/Pal/Binaries/Win64/PalDefender/WhiteList.json");
  const entries = [
    { userId: "steam_1", displayName: "steam_1", role: "管理者" },
    { userId: "steam_2", displayName: "Custom name" },
    { userId: "steam_3", displayName: "steam_3", white: true },
    { userId: "steam_4", displayName: "steam_4" },
    { userId: "steam_5", displayName: "steam_5" },
  ];
  await writeFile(join(directory, "players.json"), JSON.stringify(entries));
  await writeFile(whitelistFile, JSON.stringify(["steam_1", "steam_2", "steam_4", "steam_5", "steam_6"]));
  const online = normalized(player("1"), player("2"), player("3"), { ...player("4"), name: "   " }, { ...player("5"), name: "Invalid\nname" }, player("6"));
  await synchronizePlayers(online, null, "2026-01-04T00:00:00.000Z");
  const saved = (await readPlayers()).registeredPlayers;
  assert.equal(saved.length, 6);
  assert.equal(saved[0].displayName, "Player 1");
  assert.equal(saved[0].role, "管理者");
  assert.equal(saved[1].displayName, "Custom name");
  assert.equal(saved[2].displayName, "steam_3");
  assert.equal(saved[3].displayName, "steam_4");
  assert.equal(saved[4].displayName, "steam_5");
  assert.equal(saved[5].userId, "steam_6");
  assert.equal(saved[5].displayName, "Player 6");
  await synchronizePlayers(normalized({ ...player("1"), name: "New game name" }), online, "2026-01-04T00:00:05.000Z");
  assert.equal((await readPlayers()).registeredPlayers[0].displayName, "Player 1");
  await synchronizePlayers([], normalized(player("1")), "2026-01-04T00:00:10.000Z");
  assert.equal((await readPlayers()).registeredPlayers[0].displayName, "Player 1");
});

test("whitelist-only players retain observed names, levels and logout timestamps even when players.json did not exist", async () => {
  const { buildPlayerRows } = await import("../../app/players/player-rows.ts");
  const userId = "steam_76561198847285114";
  const whitelistFile = join(directory, "palworld/Pal/Binaries/Win64/PalDefender/WhiteList.json");
  await rm(join(directory, "players.json"));
  await writeFile(whitelistFile, JSON.stringify([userId]));
  const online = normalized({ ...player(), userId, name: "まっする", level: 2 }, player("99"));
  const loginTime = "2026-01-06T00:00:00.000Z";
  const logoutTime = "2026-01-06T00:00:15.000Z";
  await synchronizePlayers(online, null, loginTime);
  let saved = JSON.parse(await readFile(join(directory, "players.json"), "utf8"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].userId, userId);
  assert.equal(saved[0].displayName, "まっする");
  assert.equal(saved[0].level, 2);
  assert.equal(saved[0].firstLogin, loginTime);
  assert.equal(saved[0].lastLogin, null);
  await synchronizePlayers(online, online, "2026-01-06T00:00:05.000Z");
  assert.deepEqual(JSON.parse(await readFile(join(directory, "players.json"), "utf8")), saved);
  await synchronizePlayers([], online, logoutTime);
  saved = JSON.parse(await readFile(join(directory, "players.json"), "utf8"));
  assert.equal(saved[0].lastLogin, logoutTime);
  await rm(join(directory, ".players-cache.json"));
  const payload = await readPlayers();
  const [row] = buildPlayerRows(payload.onlinePlayers, payload.registeredPlayers, payload.whitelist, "");
  assert.equal(row.name, "まっする");
  assert.equal(row.level, 2);
  assert.equal(row.lastLogin, logoutTime);
  assert.equal(row.online, false);
  assert.equal(row.whitelisted, true);

  await rm(join(directory, "players.json"));
  await synchronizePlayers([], online, logoutTime);
  const [recovered] = JSON.parse(await readFile(join(directory, "players.json"), "utf8"));
  assert.equal(recovered.displayName, "まっする");
  assert.equal(recovered.level, 2);
  assert.equal(recovered.lastLogin, logoutTime);
  assert.equal(recovered.firstLogin, null);
});

test("logout timestamps persist across process restarts without the online cache or whitelist membership", async () => {
  const timestamp = "2026-01-05T00:00:15.000Z";
  await writeFile(join(directory, "players.json"), JSON.stringify([
    { userId: "steam_1", displayName: "Persistent player", lastLogin: null },
  ]));
  const online = normalized(player());
  await synchronizePlayers(online, null, "2026-01-05T00:00:00.000Z");
  await synchronizePlayers([], online, timestamp);
  assert.equal(JSON.parse(await readFile(join(directory, "players.json"), "utf8"))[0].lastLogin, timestamp);
  await rm(join(directory, ".players-cache.json"));
  await writeFile(join(directory, "palworld/Pal/Binaries/Win64/PalDefender/WhiteList.json"), "[]");

  const { stdout } = await executeFile(process.execPath, ["--input-type=module", "-e", `
    import { existsSync, readFileSync } from "node:fs";
    import { registerHooks } from "node:module";
    import { fileURLToPath } from "node:url";
    import ts from "typescript";
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier.startsWith(".") && !/\\.[a-z]+$/i.test(specifier)) {
          const url = new URL(specifier + ".ts", context.parentURL);
          if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context);
        }
        return nextResolve(specifier, context);
      },
      load(url, context, nextLoad) {
        if (url.startsWith("file:") && url.endsWith(".ts")) {
          return {
            format: "module", shortCircuit: true,
            source: ts.transpile(readFileSync(fileURLToPath(url), "utf8"), {
              module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
            }),
          };
        }
        return nextLoad(url, context);
      },
    });
    const { readPlayers } = await import("./lib/server/palworld.ts");
    const { buildPlayerRows } = await import("./app/players/player-rows.ts");
    const data = await readPlayers();
    console.log(JSON.stringify(buildPlayerRows(data.onlinePlayers, data.registeredPlayers, data.whitelist, "")));
  `], { cwd: fileURLToPath(new URL("../..", import.meta.url)), env: { ...process.env, PALUI_SERVER_DIR: directory } });
  const [row] = JSON.parse(stdout);
  assert.equal(row.name, "Persistent player");
  assert.equal(row.online, false);
  assert.equal(row.whitelisted, false);
  assert.equal(row.lastLogin, timestamp);
});

test.after(async () => {
  if (previousDirectory === undefined) delete process.env.PALUI_SERVER_DIR;
  else process.env.PALUI_SERVER_DIR = previousDirectory;
  await rm(directory, { recursive: true, force: true });
});
