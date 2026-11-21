import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bootstrapScript = path.join(repositoryRoot, "scripts/bootstrap-server.sh");

function renderCompose(t, environment = {}, useProjectTemplate = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "palui-bootstrap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const templateDirectory = path.join(root, "template");
  const destinationDirectory = path.join(root, "server");
  const hostServerDirectory = path.join(root, "host-server");
  fs.mkdirSync(templateDirectory, { recursive: true });
  fs.mkdirSync(hostServerDirectory);
  if (useProjectTemplate) {
    fs.copyFileSync(
      path.join(repositoryRoot, "palui/template/template.compose.yml"),
      path.join(templateDirectory, "template.compose.yml"),
    );
    const defaultsDirectory = path.join(templateDirectory, "defaults");
    fs.mkdirSync(defaultsDirectory);
    for (const name of ["game_balance.env", "game_features.env", "game_performance.env", "game_server.env", "system.env"]) {
      fs.writeFileSync(path.join(defaultsDirectory, name), "");
    }
    fs.writeFileSync(path.join(templateDirectory, "override.env"), "");
  } else {
    fs.writeFileSync(path.join(templateDirectory, "template.compose.yml"), [
      "---",
      "name: __PROJECT_PAL__",
      "services:",
      "  pal:",
      "    image: alpine:latest",
      "    container_name: ${COMPOSE_PROJECT_NAME}-server",
      "    volumes:",
      "      - type: bind",
      "        source: __HOST_SERVER_DIR__",
      "        target: /palworld",
      "",
    ].join("\n"));
  }

  const childEnvironment = {
    ...process.env,
    ...environment,
    PUID: String(typeof process.getuid === "function" ? process.getuid() : 0),
    PGID: String(typeof process.getgid === "function" ? process.getgid() : 0),
  };
  if (!("COMPOSE_PROJECT_NAME" in environment)) {
    delete childEnvironment.COMPOSE_PROJECT_NAME;
  }
  if (!("PROJECT" in environment)) {
    delete childEnvironment.PROJECT;
  }

  const result = spawnSync("bash", [
    bootstrapScript,
    "--template", templateDirectory,
    "--destination", destinationDirectory,
    "--host-server-dir", hostServerDirectory,
  ], { env: childEnvironment, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return {
    compose: fs.readFileSync(path.join(destinationDirectory, "compose.yml"), "utf8"),
    destinationDirectory,
  };
}

test("bootstrap embeds the inherited Compose project name", (t) => {
  const { compose } = renderCompose(t, { COMPOSE_PROJECT_NAME: "staging_pal" });

  assert.match(compose, /^name: "staging_pal"$/m);
  assert.match(compose, /container_name: \$\{COMPOSE_PROJECT_NAME\}-server/);
  assert.doesNotMatch(compose, /__[A-Z_]+__/);
});

test("bootstrap derives the standalone project name from PROJECT or defaults to dev", (t) => {
  const { compose: customCompose } = renderCompose(t, { PROJECT: "staging" });
  assert.match(customCompose, /^name: "staging_pal"$/m);

  const { compose: defaultCompose } = renderCompose(t);
  assert.match(defaultCompose, /^name: "dev_pal"$/m);
});

test("bootstrap renders the map against Palworld without a proxy service", (t) => {
  const { compose } = renderCompose(t, {}, true);

  assert.match(compose, /PALWORLD_REST_URL: http:\/\/pal:8213/);
  assert.doesNotMatch(compose, /^  proxy:/m);
});

test("Docker Compose uses the rendered name for project and container names", (t) => {
  const version = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  if (version.status !== 0) {
    t.skip("Docker Compose is unavailable");
    return;
  }

  const { destinationDirectory } = renderCompose(t, { COMPOSE_PROJECT_NAME: "staging_pal" }, true);
  const composePath = path.join(destinationDirectory, "compose.yml");
  const environment = { ...process.env };
  delete environment.COMPOSE_PROJECT_NAME;
  delete environment.PROJECT;
  const result = spawnSync("docker", [
    "compose",
    "--project-directory", destinationDirectory,
    "--file", composePath,
    "config",
    "--format", "json",
  ], { env: environment, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.name, "staging_pal");
  assert.equal(config.services.pal.container_name, "staging_pal-server");
  assert.equal(config.services.map.container_name, "staging_pal-map");
  assert.equal(config.services.map.environment.PALWORLD_REST_URL, "http://pal:8213");
  assert.equal(Object.hasOwn(config.services, "proxy"), false);
});

test("bootstrap rejects invalid Compose project names", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "palui-bootstrap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const templateDirectory = path.join(root, "template");
  const destinationDirectory = path.join(root, "server");
  const hostServerDirectory = path.join(root, "host-server");
  fs.mkdirSync(templateDirectory, { recursive: true });
  fs.mkdirSync(hostServerDirectory);
  fs.writeFileSync(path.join(templateDirectory, "template.compose.yml"), "name: __PROJECT_PAL__\n__HOST_SERVER_DIR__\n");

  const result = spawnSync("bash", [
    bootstrapScript,
    "--template", templateDirectory,
    "--destination", destinationDirectory,
    "--host-server-dir", hostServerDirectory,
  ], {
    env: {
      ...process.env,
      COMPOSE_PROJECT_NAME: "Not Valid",
      PUID: String(typeof process.getuid === "function" ? process.getuid() : 0),
      PGID: String(typeof process.getgid === "function" ? process.getgid() : 0),
    },
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid Compose project name/);
});

test("bootstrap copies only env files and updates them by modification time", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "palui-bootstrap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const template = path.join(root, "template");
  const destination = path.join(root, "server");
  fs.mkdirSync(path.join(template, "defaults"), { recursive: true });
  fs.mkdirSync(path.join(destination, "defaults"), { recursive: true });
  fs.writeFileSync(path.join(template, "template.compose.yml"), "name: __PROJECT_PAL__\nsource: __HOST_SERVER_DIR__\n");
  fs.mkdirSync(path.join(template, "defaults", "nested"));
  fs.writeFileSync(path.join(template, "defaults", "existing.env"), "template");
  fs.writeFileSync(path.join(destination, "defaults", "existing.env"), "user");
  fs.utimesSync(path.join(template, "defaults", "existing.env"), 946684800, 946684800);
  fs.utimesSync(path.join(destination, "defaults", "existing.env"), 978307200, 978307200);
  fs.writeFileSync(path.join(template, "defaults", "new.env"), "new", { mode: 0o751 });
  fs.chmodSync(path.join(template, "defaults", "new.env"), 0o751);
  fs.utimesSync(path.join(template, "defaults", "new.env"), 946684800, 946684800);
  fs.writeFileSync(path.join(template, "override.env"), "override");
  fs.writeFileSync(path.join(template, "ignore.sh"), "ignored");
  fs.writeFileSync(path.join(template, "defaults", "nested", "ignore.env"), "ignored");
  fs.writeFileSync(path.join(destination, "template.compose.yml"), "stale");
  const run = () => spawnSync("bash", [
    bootstrapScript, "--template", template, "--destination", destination, "--host-server-dir", root,
  ], { encoding: "utf8", env: { ...process.env, COMPOSE_PROJECT_NAME: "test_pal" } });

  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(path.join(destination, "defaults", "existing.env"), "utf8"), "user");
  assert.equal(fs.readFileSync(path.join(destination, "defaults", "new.env"), "utf8"), "new");
  assert.equal(fs.statSync(path.join(destination, "defaults", "new.env")).mode & 0o777, 0o751);
  assert.equal(fs.statSync(path.join(destination, "defaults", "new.env")).mtimeMs, 946684800000);
  assert.equal(fs.readFileSync(path.join(destination, "override.env"), "utf8"), "override");
  assert.equal(fs.existsSync(path.join(destination, "ignore.sh")), false);
  assert.equal(fs.existsSync(path.join(destination, "defaults", "nested")), false);
  assert.equal(fs.readFileSync(path.join(destination, "template.compose.yml"), "utf8"), "stale");
  fs.utimesSync(path.join(template, "defaults", "existing.env"), 1009843200, 1009843200);
  fs.writeFileSync(path.join(destination, "compose.yml"), "local edits");
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(path.join(destination, "defaults", "existing.env"), "utf8"), "template");
  assert.match(fs.readFileSync(path.join(destination, "compose.yml"), "utf8"), /^# Generated/);
});

test("bootstrap safely renders special host path characters", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "palui-bootstrap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const template = path.join(root, "template");
  const destination = path.join(root, "server");
  const host = path.join(root, 'host $HOME "quote" \\ backslash & pipe |\n');
  fs.mkdirSync(template);
  fs.mkdirSync(host);
  fs.writeFileSync(path.join(template, "template.compose.yml"), "name: __PROJECT_PAL__\nsource: __HOST_SERVER_DIR__\n");
  const result = spawnSync("bash", [
    bootstrapScript, "--template", template, "--destination", destination, "--host-server-dir", host,
  ], { encoding: "utf8", env: { ...process.env, COMPOSE_PROJECT_NAME: "test_pal" } });

  assert.equal(result.status, 0, result.stderr);
  const compose = fs.readFileSync(path.join(destination, "compose.yml"), "utf8");
  const source = compose.match(/^source: (.+)$/m);
  assert.ok(source);
  assert.equal(JSON.parse(source[1]), `${host.replaceAll("$", () => "$$")}/palworld`);
});

test("bootstrap leaves the existing compose intact when a placeholder is missing", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "palui-bootstrap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const template = path.join(root, "template");
  const destination = path.join(root, "server");
  fs.mkdirSync(template);
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(template, "template.compose.yml"), "name: __PROJECT_PAL__\n");
  fs.writeFileSync(path.join(destination, "compose.yml"), "original");
  const result = spawnSync("bash", [
    bootstrapScript, "--template", template, "--destination", destination, "--host-server-dir", root,
  ], { encoding: "utf8", env: { ...process.env, COMPOSE_PROJECT_NAME: "test_pal" } });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not contain __HOST_SERVER_DIR__/);
  assert.equal(fs.readFileSync(path.join(destination, "compose.yml"), "utf8"), "original");
});

test("bootstrap rejects invalid IDs and nonexistent host paths", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "palui-bootstrap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const template = path.join(root, "template");
  fs.mkdirSync(template);
  fs.writeFileSync(path.join(template, "template.compose.yml"), "name: __PROJECT_PAL__\nsource: __HOST_SERVER_DIR__\n");
  const args = [
    bootstrapScript, "--template", template, "--destination", path.join(root, "server"),
    "--host-server-dir", path.join(root, "missing"),
  ];
  const invalidId = spawnSync("bash", args, {
    encoding: "utf8", env: { ...process.env, PUID: "", COMPOSE_PROJECT_NAME: "test_pal" },
  });
  assert.notEqual(invalidId.status, 0);
  assert.match(invalidId.stderr, /PUID must be a non-negative integer/);

  const missingHost = spawnSync("bash", args, {
    encoding: "utf8",
    env: { ...process.env, PUID: String(process.getuid()), PGID: String(process.getgid()), COMPOSE_PROJECT_NAME: "test_pal" },
  });
  assert.notEqual(missingHost.status, 0);
  assert.match(missingHost.stderr, /Server initialization failed/);
});