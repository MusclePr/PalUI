import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bootstrapScript = path.join(repositoryRoot, "scripts/bootstrap-server.mjs");

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

  const result = spawnSync(process.execPath, [
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
  assert.equal(config.services.proxy.container_name, "staging_pal-proxy");
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

  const result = spawnSync(process.execPath, [
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