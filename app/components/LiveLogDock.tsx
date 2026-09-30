"use client";

import { ChevronDown, ChevronUp, Download, RefreshCw, TerminalSquare } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

type LogService = "pal" | "proxy" | "map";
type LogEntry = { id: number; source: "stdout" | "stderr"; line: string; timestamp: string | null };
type StreamMessage = { source?: unknown; line?: unknown; timestamp?: unknown; message?: unknown };
type LogEntriesByService = Record<LogService, LogEntry[]>;
type StreamState = "connecting" | "connected" | "reconnecting" | "disconnected";

const services: LogService[] = ["pal", "proxy", "map"];
const storageKey = "palui-live-log-dock";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/palui";
const maxCachedEntries = 300;
const maxCachedLineLength = 2048;
const ansiPalette = ["#000000", "#cc3333", "#33cc33", "#cccc33", "#3333cc", "#cc33cc", "#33cccc", "#cccccc", "#555555", "#ff5555", "#55ff55", "#ffff55", "#5555ff", "#ff55ff", "#55ffff", "#ffffff"];

type AnsiStyle = { foreground?: string; background?: string; bold?: boolean; italic?: boolean; underline?: boolean };

function ansiColor(index: number) {
  if (index < 16) return ansiPalette[index];
  if (index < 232) {
    const red = Math.floor((index - 16) / 36);
    const green = Math.floor(((index - 16) % 36) / 6);
    const blue = (index - 16) % 6;
    return `#${[red, green, blue].map((channel) => (channel === 0 ? 0 : 55 + channel * 40).toString(16).padStart(2, "0")).join("")}`;
  }
  const gray = (8 + (index - 232) * 10).toString(16).padStart(2, "0");
  return `#${gray}${gray}${gray}`;
}

function renderAnsiLine(line: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const escapePattern = /\u001B\[([0-?]*[ -/]*[@-~])/g;
  let style: AnsiStyle = {};
  let offset = 0;

  function appendText(text: string) {
    if (!text) return;
    const cssStyle: CSSProperties = {
      color: style.foreground,
      backgroundColor: style.background,
      fontWeight: style.bold ? "bold" : undefined,
      fontStyle: style.italic ? "italic" : undefined,
      textDecoration: style.underline ? "underline" : undefined,
    };
    parts.push(Object.keys(style).length ? <span key={parts.length} style={cssStyle}>{text}</span> : text);
  }

  for (const match of line.matchAll(escapePattern)) {
    const escape = match[0];
    const index = match.index ?? 0;
    appendText(line.slice(offset, index));
    offset = index + escape.length;
    if (!escape.endsWith("m")) continue;

    const codes = escape.slice(2, -1).split(";").map((code) => Number(code || 0));
    for (let codeIndex = 0; codeIndex < codes.length; codeIndex += 1) {
      const code = codes[codeIndex];
      if (code === 0) style = {};
      else if (code === 1) style.bold = true;
      else if (code === 3) style.italic = true;
      else if (code === 4) style.underline = true;
      else if (code === 22) style.bold = false;
      else if (code === 23) style.italic = false;
      else if (code === 24) style.underline = false;
      else if (code === 39) delete style.foreground;
      else if (code === 49) delete style.background;
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) style.foreground = ansiPalette[code >= 90 ? code - 82 : code - 30];
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) style.background = ansiPalette[code >= 100 ? code - 92 : code - 40];
      else if (code === 38 || code === 48) {
        const colorProperty = code === 38 ? "foreground" : "background";
        const mode = codes[codeIndex + 1];
        if (mode === 5 && codes[codeIndex + 2] !== undefined) {
          style[colorProperty] = ansiColor(Math.max(0, Math.min(255, codes[codeIndex + 2])));
          codeIndex += 2;
        } else if (mode === 2 && codes[codeIndex + 4] !== undefined) {
          const rgb = codes.slice(codeIndex + 2, codeIndex + 5).map((channel) => Math.max(0, Math.min(255, channel)));
          style[colorProperty] = `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
          codeIndex += 4;
        }
      }
    }
  }

  appendText(line.slice(offset));
  return parts;
}

function emptyLogEntries(): LogEntriesByService {
  return { pal: [], proxy: [], map: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCachedEntries(value: unknown, nextId: { current: number }): LogEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.line !== "string") return [];
    const entry = {
      id: typeof item.id === "number" ? item.id : nextId.current,
      source: item.source === "stderr" ? "stderr" as const : "stdout" as const,
      line: item.line.slice(-maxCachedLineLength),
      timestamp: typeof item.timestamp === "string" ? item.timestamp : null,
    };
    nextId.current = Math.max(nextId.current + 1, entry.id + 1);
    return [entry];
  }).slice(-maxCachedEntries);
}

function streamStateLabel(state: StreamState) {
  return { connecting: "接続中", connected: "LIVE", reconnecting: "再接続中", disconnected: "停止・切断" }[state];
}

function isLogService(value: unknown): value is LogService {
  return typeof value === "string" && services.includes(value as LogService);
}

export function LiveLogDock({ lifecycleReconnectRequest }: { lifecycleReconnectRequest: number }) {
  const [expanded, setExpanded] = useState(false);
  const [service, setService] = useState<LogService>("pal");
  const [entriesByService, setEntriesByService] = useState<LogEntriesByService>(emptyLogEntries);
  const [streamState, setStreamState] = useState<StreamState>("connecting");
  const [reconnectRequest, setReconnectRequest] = useState(0);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const nextEntryId = useRef(0);
  const logWindow = useRef<HTMLDivElement>(null);
  const savedPreferences = useRef({ expanded, service, entriesByService });
  const entries = entriesByService[service];

  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const preferences = JSON.parse(saved) as { expanded?: unknown; service?: unknown; entries?: unknown };
        if (typeof preferences.expanded === "boolean") setExpanded(preferences.expanded);
        if (isLogService(preferences.service)) setService(preferences.service);
        if (isRecord(preferences.entries)) {
          const cachedEntries = emptyLogEntries();
          for (const item of services) cachedEntries[item] = readCachedEntries(preferences.entries[item], nextEntryId);
          setEntriesByService(cachedEntries);
        }
      }
    } catch {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        setExpanded(false);
        setService("pal");
      }
    }
    setPreferencesLoaded(true);
  }, []);

  useEffect(() => {
    savedPreferences.current = { expanded, service, entriesByService };
  }, [expanded, entriesByService, service]);

  useEffect(() => {
    if (!preferencesLoaded) return;
    const timeout = window.setTimeout(() => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(savedPreferences.current));
      } catch {
        return;
      }
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [expanded, entriesByService, preferencesLoaded, service]);

  useEffect(() => {
    if (!preferencesLoaded) return;
    function persistBeforeNavigation() {
      try {
        localStorage.setItem(storageKey, JSON.stringify(savedPreferences.current));
      } catch {
        return;
      }
    }
    window.addEventListener("pagehide", persistBeforeNavigation);
    return () => window.removeEventListener("pagehide", persistBeforeNavigation);
  }, [preferencesLoaded]);

  useEffect(() => {
    if (!preferencesLoaded) return;
    setStreamState("connecting");
    const source = new EventSource(`${basePath}/api/server/logs?service=${service}`);
    source.onopen = () => setStreamState("connected");
    source.onerror = () => setStreamState("reconnecting");
    source.addEventListener("log", (event) => {
      try {
        const message = JSON.parse((event as MessageEvent<string>).data) as StreamMessage;
        if (typeof message.line !== "string" || !message.line.trim()) return;
        const entry: LogEntry = {
          id: nextEntryId.current++,
          source: message.source === "stderr" ? "stderr" : "stdout",
          line: message.line.slice(-maxCachedLineLength),
          timestamp: typeof message.timestamp === "string" ? message.timestamp : null,
        };
        setEntriesByService((current) => ({
          ...current,
          [service]: [...current[service], entry].slice(-maxCachedEntries),
        }));
      } catch {
        setStreamState("reconnecting");
      }
    });
    source.addEventListener("stream-ended", () => {
      setStreamState("reconnecting");
    });
    source.addEventListener("stream-error", () => {
      setStreamState("reconnecting");
    });

    return () => source.close();
  }, [lifecycleReconnectRequest, preferencesLoaded, reconnectRequest, service]);

  useEffect(() => {
    if (!expanded || !logWindow.current) return;
    logWindow.current.scrollTop = logWindow.current.scrollHeight;
  }, [entries, expanded]);

  function downloadLogs() {
    const contents = entries.map((entry) => `${entry.timestamp ?? ""}\t${entry.source}\t${entry.line}`).join("\n");
    const url = URL.createObjectURL(new Blob([contents], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `palui-${service}-logs.txt`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function reconnectLogs() {
    setStreamState("connecting");
    setReconnectRequest((current) => current + 1);
  }

  return (
    <aside className={`live-log-dock ${expanded ? "is-expanded" : ""}`} data-expanded={expanded} aria-label="ログ">
      {expanded && (
        <div className="live-log-panel">
          <div className="live-log-panel-heading">
            <div><p className="eyebrow">COMPOSE / {service.toUpperCase()}</p><strong>ログ</strong></div>
            <span className={`live-log-state ${streamState}`}><i />{streamStateLabel(streamState)}</span>
          </div>
          <div className="live-log-window" ref={logWindow} role="log" aria-live="polite" aria-relevant="additions">
            {entries.length === 0 && <p className="live-log-empty">ログはありません</p>}
            {entries.map((entry) => (
              <div className={`live-log-entry ${entry.source}`} key={entry.id}>
                <time dateTime={entry.timestamp ?? undefined}>{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString("ja-JP", { hour12: false }) : ""}</time>
                <span>{renderAnsiLine(entry.line)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="live-log-bar">
        <button className="live-log-toggle" type="button" aria-label={expanded ? "ログを格納" : "ログを展開"} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          <TerminalSquare size={16} />
          <strong>ログ</strong>
          {expanded ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
        <span className={`live-log-state ${streamState}`}><i />{streamStateLabel(streamState)}</span>
        <label className="live-log-service">
          <span className="sr-only">ログ対象サービス</span>
          <select value={service} onChange={(event) => setService(event.target.value as LogService)}>
            {services.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <button className="icon-button live-log-reconnect" type="button" aria-label="ログを再接続" title="ログを再接続" onClick={reconnectLogs} disabled={streamState === "connecting" || streamState === "connected"}>
          <RefreshCw size={15} />
        </button>
        <button className="icon-button live-log-download" type="button" aria-label="表示中のログをダウンロード" title="表示中のログをダウンロード" onClick={downloadLogs} disabled={entries.length === 0}>
          <Download size={15} />
        </button>
      </div>
    </aside>
  );
}