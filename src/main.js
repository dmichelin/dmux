const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFileSync } = require("child_process");
const { app, BrowserWindow, ipcMain } = require("electron");
const pty = require("node-pty");

const panes = new Map();
let mainWindow = null;
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const projectRoot = path.join(__dirname, "..");

loadDotEnv();

function loadDotEnv() {
  const envPath = path.join(projectRoot, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key]) {
      continue;
    }

    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#111417",
    title: "dmux",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function getShell() {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "powershell.exe";
  }

  if (process.platform === "darwin") {
    return "/bin/zsh";
  }

  return process.env.SHELL || "/bin/bash";
}

function getShellArgs() {
  if (process.platform === "win32") {
    return [];
  }

  return ["-l"];
}

function getCandidateShells() {
  if (process.platform === "win32") {
    return [getShell()];
  }

  return [...new Set([getShell(), process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].filter(Boolean))].filter((shellPath) =>
    fs.existsSync(shellPath)
  );
}

function getCandidateCwds(preferredCwd) {
  return [...new Set([preferredCwd, process.env.HOME, os.homedir(), "/tmp"].filter(Boolean))].filter((candidate) => {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });
}

function buildPtyEnv(shell) {
  return {
    TERM: process.env.TERM || "xterm-256color",
    HOME: process.env.HOME || os.homedir(),
    USER: process.env.USER || os.userInfo().username,
    LOGNAME: process.env.LOGNAME || process.env.USER || os.userInfo().username,
    SHELL: shell,
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: process.env.LANG || "en_US.UTF-8",
    COLORTERM: process.env.COLORTERM || "truecolor"
  };
}

function spawnPaneProcess({ cols, rows, cwd }) {
  const errors = [];

  for (const shell of getCandidateShells()) {
    for (const resolvedCwd of getCandidateCwds(cwd)) {
      try {
        const ptyProcess = pty.spawn(shell, getShellArgs(), {
          name: "xterm-256color",
          cols,
          rows,
          cwd: resolvedCwd,
          env: buildPtyEnv(shell)
        });

        return { ptyProcess, shell, cwd: resolvedCwd };
      } catch (error) {
        errors.push(`${shell} @ ${resolvedCwd}: ${error.message}`);
      }
    }
  }

  throw new Error(`Unable to spawn PTY. Tried ${errors.join(" | ")}`);
}

function createPane(_, { paneId, cols = 80, rows = 24, cwd }) {
  if (panes.has(paneId)) {
    return { ok: true };
  }

  const { ptyProcess, shell, cwd: resolvedCwd } = spawnPaneProcess({ cols, rows, cwd });

  ptyProcess.onData((data) => {
    mainWindow?.webContents.send("pty:data", { paneId, data });
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    panes.delete(paneId);
    mainWindow?.webContents.send("pty:exit", { paneId, exitCode, signal });
  });

  panes.set(paneId, {
    ptyProcess,
    shell,
    cwd: resolvedCwd
  });
  return { ok: true, shell, cwd: resolvedCwd, pid: ptyProcess.pid };
}

function writePane(_, { paneId, data }) {
  const paneRecord = panes.get(paneId);
  if (!paneRecord) {
    return { ok: false };
  }

  paneRecord.ptyProcess.write(data);
  return { ok: true };
}

function resizePane(_, { paneId, cols, rows }) {
  const paneRecord = panes.get(paneId);
  if (!paneRecord || cols < 2 || rows < 1) {
    return { ok: false };
  }

  paneRecord.ptyProcess.resize(cols, rows);
  return { ok: true };
}

function killPane(_, paneId) {
  const paneRecord = panes.get(paneId);
  if (!paneRecord) {
    return { ok: true };
  }

  paneRecord.ptyProcess.kill();
  panes.delete(paneId);
  return { ok: true };
}

function getPaneCurrentCwd(paneRecord) {
  if (!paneRecord) {
    return null;
  }

  const pid = paneRecord.ptyProcess.pid;
  if (!pid) {
    return paneRecord.cwd;
  }

  if (process.platform === "darwin") {
    try {
      const output = execFileSync("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      });
      const cwdLine = output.split("\n").find((line) => line.startsWith("n"));
      if (cwdLine) {
        return cwdLine.slice(1);
      }
    } catch {
      return paneRecord.cwd;
    }
  }

  if (process.platform === "linux") {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return paneRecord.cwd;
    }
  }

  return paneRecord.cwd;
}

function parseJsonResponse(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("The model returned an empty response.");
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  const candidate = fencedMatch ? fencedMatch[1] : trimmed;
  return JSON.parse(candidate);
}

function getAiProvider() {
  return (process.env.DMUX_AI_PROVIDER || "openai").trim().toLowerCase();
}

function buildAiMessages(paneRecord, paneName, cwd, prompt, recentOutput) {
  return {
    system:
      "You translate natural language into terminal commands. Return strict JSON with a top-level suggestions array. Each suggestion must have command and explanation. Commands must be plain shell commands with no markdown fences, no leading prompt symbol, and no trailing newline. Prefer safe, inspectable commands when the request is ambiguous or potentially destructive. Use the provided shell, cwd, pane name, and recent terminal output as context.",
    context: {
      pane_name: paneName,
      shell: paneRecord.shell,
      cwd,
      recent_terminal_output: recentOutput,
      request: prompt
    }
  };
}

async function requestOpenAiSuggestions(paneRecord, paneName, cwd, prompt, recentOutput) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Set OPENAI_API_KEY before using the OpenAI backend.");
  }

  const model = process.env.DMUX_OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const aiPrompt = buildAiMessages(paneRecord, paneName, cwd, prompt, recentOutput);
  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: {
        type: "json_object"
      },
      messages: [
        {
          role: "system",
          content: aiPrompt.system
        },
        {
          role: "user",
          content: JSON.stringify(aiPrompt.context)
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return {
    provider: "openai",
    model,
    content: data.choices?.[0]?.message?.content || ""
  };
}

async function requestAnthropicSuggestions(paneRecord, paneName, cwd, prompt, recentOutput) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Set ANTHROPIC_API_KEY before using the Anthropic backend.");
  }

  const model =
    process.env.DMUX_ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";
  const aiPrompt = buildAiMessages(paneRecord, paneName, cwd, prompt, recentOutput);
  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      temperature: 0.2,
      system: aiPrompt.system,
      messages: [
        {
          role: "user",
          content: JSON.stringify(aiPrompt.context)
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic request failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = Array.isArray(data.content)
    ? data.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n")
    : "";

  return {
    provider: "anthropic",
    model,
    content
  };
}

async function suggestAiCommands(_, { paneId, paneName, prompt, recentOutput }) {
  const paneRecord = panes.get(paneId);
  if (!paneRecord) {
    throw new Error("The focused pane is no longer available.");
  }

  if (!prompt?.trim()) {
    throw new Error("Enter a request for the AI command assistant.");
  }

  const cwd = getPaneCurrentCwd(paneRecord) || paneRecord.cwd;
  const provider = getAiProvider();
  const result =
    provider === "anthropic"
      ? await requestAnthropicSuggestions(paneRecord, paneName, cwd, prompt, recentOutput)
      : await requestOpenAiSuggestions(paneRecord, paneName, cwd, prompt, recentOutput);
  const content = result.content;
  const parsed = parseJsonResponse(content);
  const suggestions = Array.isArray(parsed.suggestions)
    ? parsed.suggestions
        .map((item) => ({
          command: String(item.command || "").trim(),
          explanation: String(item.explanation || "").trim()
        }))
        .filter((item) => item.command)
        .slice(0, 5)
    : [];

  if (suggestions.length === 0) {
    throw new Error("The model did not return any usable command suggestions.");
  }

  return {
    ok: true,
    provider: result.provider,
    model: result.model,
    pane: {
      shell: paneRecord.shell,
      cwd
    },
    suggestions
  };
}

app.whenReady().then(() => {
  ipcMain.handle("pane:create", createPane);
  ipcMain.handle("pane:write", writePane);
  ipcMain.handle("pane:resize", resizePane);
  ipcMain.handle("pane:kill", killPane);
  ipcMain.handle("ai:suggest", suggestAiCommands);

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  for (const paneRecord of panes.values()) {
    paneRecord.ptyProcess.kill();
  }
  panes.clear();

  if (process.platform !== "darwin") {
    app.quit();
  }
});
