import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLogStreamResponse } from "../../lib/server/log-stream.ts";

async function waitForFile(path, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  return false;
}

test("SSE preserves ANSI colors and timestamps, and stops the child process on disconnect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "palui-log-stream-"));
  const scriptPath = join(directory, "fake-docker");
  const stoppedPath = join(directory, "stopped");
  const previousMarker = process.env.PALUI_LOG_TEST_MARKER;
  process.env.PALUI_LOG_TEST_MARKER = stoppedPath;
  const controller = new AbortController();

  try {
    await writeFile(scriptPath, `#!/bin/sh
trap 'printf stopped > "$PALUI_LOG_TEST_MARKER"; exit 0' TERM
  printf '2026-09-29T12:00:00Z \\033[31mready\\033[0m\\nplain line without timestamp\\n'
while :; do sleep 1 & wait $!; done
`);
    await chmod(scriptPath, 0o755);

    const request = new Request("http://localhost/api/server/logs", { signal: controller.signal });
    const response = createLogStreamResponse(request, { command: scriptPath, args: [], cwd: directory });
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");

    const reader = response.body.getReader();
    let eventText = "";
    while (!eventText.includes("plain line without timestamp")) {
      const next = await reader.read();
      assert.equal(next.done, false);
      eventText += new TextDecoder().decode(next.value);
    }
    assert.match(eventText, /event: log/);
    const payloads = [...eventText.matchAll(/data: (.+)\n/g)].map((match) => JSON.parse(match[1]));
    assert.equal(payloads[0].line, "\u001B[31mready\u001B[0m");
    assert.equal(payloads[0].timestamp, "2026-09-29T12:00:00.000Z");
    assert.equal(payloads[1].line, "plain line without timestamp");
    assert.equal(payloads[1].timestamp, null);

    controller.abort();
    assert.equal(await waitForFile(stoppedPath), true);
    await reader.cancel().catch(() => undefined);
  } finally {
    controller.abort();
    if (previousMarker === undefined) delete process.env.PALUI_LOG_TEST_MARKER;
    else process.env.PALUI_LOG_TEST_MARKER = previousMarker;
    await rm(directory, { recursive: true, force: true });
  }
});

test("SSE closes after the log process exits and ignores blank lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "palui-log-ended-"));
  const scriptPath = join(directory, "finished-docker");

  try {
    await writeFile(scriptPath, "#!/bin/sh\nprintf '2026-09-29T12:00:00Z stopped\\n\\n'\n");
    await chmod(scriptPath, 0o755);

    const response = createLogStreamResponse(new Request("http://localhost/api/server/logs"), {
      command: scriptPath,
      args: [],
      cwd: directory,
    });
    const body = await response.text();
    assert.equal([...body.matchAll(/event: log\n/g)].length, 1);
    assert.match(body, /event: stream-ended/);
    assert.doesNotMatch(body, /event: stream-error/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});