import type { CSSProperties, ReactNode } from "react";

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

export function renderAnsiLine(line: string): ReactNode[] {
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

export function isErrorLogLine(line: string) {
  return /\b(?:error|fatal|failed)\b|error response from daemon|bind for .* already allocated|エラーが発生|起動コマンドでエラー/i.test(line);
}