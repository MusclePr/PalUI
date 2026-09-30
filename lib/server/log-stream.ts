import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type LogCommand = { command: string; args: readonly string[]; cwd: string };

function parseLogLine(value: string) {
  const line = value;
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s(.*)$/);
  if (!match) return { line, timestamp: null };

  const timestamp = match[1].replace(/\.(\d{3})\d+Z$/, ".$1Z");
  return {
    line: match[2],
    timestamp: Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : null,
  };
}

export function createLogStreamResponse(request: Request, command: LogCommand) {
  const encoder = new TextEncoder();
  let child: ReturnType<typeof spawn> | null = null;
  let cancelStream = () => undefined;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      let stdoutBuffer = "";
      let stderrBuffer = "";
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");

      function closeStream() {
        if (!open) return;
        open = false;
        if (heartbeat) clearInterval(heartbeat);
        request.signal.removeEventListener("abort", cancelStream);
        try {
          controller.close();
        } catch {
          // The browser may have cancelled the stream before the child process closed.
        }
      }

      function send(event: string, payload: unknown) {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
        } catch {
          cancelStream();
          return;
        }
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          child?.stdout?.pause();
          child?.stderr?.pause();
        }
      }

      function sendLines(source: "stdout" | "stderr", chunk: string, flush = false) {
        const current = source === "stdout" ? stdoutBuffer : stderrBuffer;
        let combined = `${current}${chunk}`;
        const maxLineLength = 16_384;
        if (!combined.includes("\n") && combined.length > maxLineLength) {
          combined = `[line truncated] ${combined.slice(-(maxLineLength - 16))}`;
        }

        const lines = combined.split(/\r?\n/);
        const remainder = flush ? "" : lines.pop() ?? "";
        if (source === "stdout") stdoutBuffer = remainder;
        else stderrBuffer = remainder;

        for (const line of lines) {
          if (line.trim()) send("log", { source, ...parseLogLine(line) });
        }
        if (flush && remainder.trim()) send("log", { source, ...parseLogLine(remainder) });
      }

      cancelStream = () => {
        if (child && !child.killed) child.kill("SIGTERM");
        closeStream();
      };

      heartbeat = setInterval(() => {
        if (!open) return;
        if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          cancelStream();
        }
      }, 15_000);

      try {
        child = spawn(command.command, [...command.args], {
          cwd: command.cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        send("stream-error", { message: "ログストリームを開始できませんでした" });
        closeStream();
        return;
      }

      child.stdout?.on("data", (chunk: Buffer) => sendLines("stdout", stdoutDecoder.write(chunk)));
      child.stderr?.on("data", (chunk: Buffer) => sendLines("stderr", stderrDecoder.write(chunk)));
      child.on("error", () => {
        send("stream-error", { message: "Dockerログへ接続できませんでした" });
        closeStream();
      });
      child.on("close", (code) => {
        sendLines("stdout", stdoutDecoder.end(), true);
        sendLines("stderr", stderrDecoder.end(), true);
        if (code !== 0) send("stream-error", { message: "ログストリームが切断されました" });
        else send("stream-ended", { message: "ログストリームが終了しました" });
        closeStream();
      });

      if (request.signal.aborted) cancelStream();
      else request.signal.addEventListener("abort", cancelStream, { once: true });
    },
    pull() {
      child?.stdout?.resume();
      child?.stderr?.resume();
    },
    cancel() {
      cancelStream();
    },
  }, { highWaterMark: 32 });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}