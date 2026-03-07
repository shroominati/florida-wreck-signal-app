#!/usr/bin/env node

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

loadDotEnv(path.join(process.cwd(), ".env"));

const DEFAULT_PROJECTS = Object.freeze({
  clawbot: "/Users/alfredmunoz/clawbot",
  "dual-caption": "/Users/alfredmunoz/Projects/dual-caption",
  saas_test: "/Users/alfredmunoz/Projects/saas_test",
  milestone_test: "/Users/alfredmunoz/Projects/milestone-test",
});

const SAFE_PROMPT_PREFIX =
  "Operate conservatively. Prefer minimal changes, preserve existing behavior, and verify before claiming success.";
const MAX_TELEGRAM_MESSAGE = 3500;
const MAX_OUTPUT_CAPTURE = 120000;
const MAX_TAIL_LINES = 200;

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) {
      continue;
    }

    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function expandHome(value) {
  if (!value || !value.startsWith("~")) {
    return value;
  }
  return path.join(os.homedir(), value.slice(1));
}

function coerceBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  return String(value).toLowerCase() === "true";
}

function sanitizeSandbox(value, fallback = "workspace-write") {
  if (value === "read-only" || value === "workspace-write") {
    return value;
  }
  return fallback;
}

function summarizeText(text, limit = 120) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function chunkText(text, size = MAX_TELEGRAM_MESSAGE) {
  const source = String(text || "(no output)");
  const chunks = [];
  let remaining = source;

  while (remaining.length > size) {
    let splitAt = remaining.lastIndexOf("\n", size);
    if (splitAt < size * 0.5) {
      splitAt = size;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }

  chunks.push(remaining);
  return chunks;
}

function senderInfo(message) {
  return {
    chatId: message?.chat?.id ?? null,
    userId: message?.from?.id ?? null,
    username: message?.from?.username || "",
    firstName: message?.from?.first_name || "",
    lastName: message?.from?.last_name || "",
  };
}

function projectNameForPath(targetPath, projectMap) {
  const normalized = path.resolve(targetPath);
  for (const [name, projectPath] of Object.entries(projectMap)) {
    if (path.resolve(projectPath) === normalized) {
      return name;
    }
  }
  return null;
}

function buildConfig(overrides = {}) {
  const projectMap = { ...DEFAULT_PROJECTS, ...(overrides.projectMap || {}) };
  const requestedWorkdir = path.resolve(
    expandHome(overrides.workdir || process.env.TELEGRAM_WORKDIR || projectMap.clawbot),
  );
  const defaultProject =
    overrides.defaultProject ||
    process.env.SPICY_DEFAULT_PROJECT ||
    projectNameForPath(requestedWorkdir, projectMap) ||
    "clawbot";

  return {
    botToken: overrides.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? "",
    allowedChatId: String(
      overrides.allowedChatId ?? process.env.TELEGRAM_ALLOWED_CHAT_ID ?? "",
    ),
    allowedUserId: String(
      overrides.allowedUserId ?? process.env.TELEGRAM_ALLOWED_USER_ID ?? "",
    ),
    pollTimeoutSec: Number(
      overrides.pollTimeoutSec ?? process.env.TELEGRAM_POLL_TIMEOUT_SEC ?? 30,
    ),
    commandTimeoutMs: Number(
      overrides.commandTimeoutMs ??
        process.env.TELEGRAM_COMMAND_TIMEOUT_MS ??
        15 * 60 * 1000,
    ),
    skipOldUpdates: coerceBoolean(
      overrides.skipOldUpdates ?? process.env.TELEGRAM_SKIP_OLD_UPDATES,
      true,
    ),
    shellEnabled: coerceBoolean(
      overrides.shellEnabled ?? process.env.TELEGRAM_ENABLE_SHELL,
      false,
    ),
    logPath: path.resolve(
      expandHome(
        overrides.logPath ||
          process.env.TELEGRAM_BOT_LOG_PATH ||
          "~/.spicywhite/logs/telegram-codex-bot.log",
      ),
    ),
    snapshotDir: path.resolve(
      expandHome(
        overrides.snapshotDir || process.env.SPICY_SNAPSHOT_DIR || "~/archive",
      ),
    ),
    webHealthUrl:
      overrides.webHealthUrl || process.env.SPICY_WEB_HEALTH_URL || "http://127.0.0.1:8787/health",
    projectMap,
    defaultProject,
    defaultMode:
      String(overrides.defaultMode || process.env.CODEX_DEFAULT_MODE || "safe").toLowerCase() ===
      "fast"
        ? "fast"
        : "safe",
    safeSandbox: sanitizeSandbox(
      overrides.safeSandbox || process.env.CODEX_SAFE_SANDBOX || "workspace-write",
      "workspace-write",
    ),
    fastSandbox: sanitizeSandbox(
      overrides.fastSandbox || process.env.CODEX_FAST_SANDBOX || "workspace-write",
      "workspace-write",
    ),
    model: overrides.model || process.env.CODEX_MODEL || "",
    sendMessageImpl: overrides.sendMessageImpl || null,
    fetchImpl: overrides.fetchImpl || global.fetch,
    spawnImpl: overrides.spawnImpl || spawn,
    spawnSyncImpl: overrides.spawnSyncImpl || spawnSync,
    execSpecBuilder: overrides.execSpecBuilder || null,
  };
}

function createBridge(overrides = {}) {
  const config = buildConfig(overrides);
  const knownLogs = {
    bot: config.logPath,
    web: path.resolve(
      expandHome(process.env.TELEGRAM_TAIL_WEB_LOG || "~/.spicywhite/logs/web-console.log"),
    ),
    telegram: path.resolve(
      expandHome(
        process.env.TELEGRAM_TAIL_TELEGRAM_LOG || "~/.spicywhite/logs/telegram-console.log",
      ),
    ),
    errors: path.resolve(
      expandHome(process.env.TELEGRAM_TAIL_ERRORS_LOG || "~/.spicywhite/logs/bot.errors.log"),
    ),
  };

  const state = {
    offset: 0,
    currentProject: config.projectMap[config.defaultProject]
      ? config.defaultProject
      : "clawbot",
    currentMode: config.defaultMode,
    activeRun: null,
    lastRun: null,
    lastError: "none",
  };

  bootstrapFilesystem();

  function bootstrapFilesystem() {
    fs.mkdirSync(path.dirname(config.logPath), { recursive: true });

    if (!config.projectMap[state.currentProject]) {
      throw new Error(`Unknown default project: ${state.currentProject}`);
    }

    for (const [name, projectPath] of Object.entries(config.projectMap)) {
      if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
        throw new Error(`Configured project path missing for ${name}: ${projectPath}`);
      }
    }
  }

  function activeProjectPath() {
    return config.projectMap[state.currentProject];
  }

  function logAction(entry) {
    const payload = {
      ts: new Date().toISOString(),
      event: entry.event,
      project: state.currentProject,
      cwd: entry.cwd || activeProjectPath(),
      mode: state.currentMode,
      ...entry,
    };
    fs.appendFileSync(config.logPath, `${JSON.stringify(payload)}\n`);
  }

  function snapshotRepoState(cwd) {
    const result = config.spawnSyncImpl(
      "git",
      ["-C", cwd, "status", "--porcelain", "--untracked-files=all"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    if (result.status !== 0) {
      return null;
    }

    const files = new Map();
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      files.set(line.slice(3).trim(), line.slice(0, 2));
    }
    return files;
  }

  function diffRepoState(before, after) {
    if (!before || !after) {
      return [];
    }

    const names = new Set([...before.keys(), ...after.keys()]);
    return [...names].filter((name) => before.get(name) !== after.get(name)).sort();
  }

  async function telegram(method, payload) {
    if (!config.fetchImpl) {
      throw new Error("fetch is unavailable in this Node runtime");
    }

    const response = await config.fetchImpl(
      `https://api.telegram.org/bot${config.botToken}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    const data = await response.json();
    if (!data.ok) {
      throw new Error(`${method} failed: ${JSON.stringify(data)}`);
    }
    return data.result;
  }

  async function sendMessage(chatId, text) {
    if (config.sendMessageImpl) {
      await config.sendMessageImpl(chatId, text);
      return;
    }

    for (const chunk of chunkText(text)) {
      await telegram("sendMessage", {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      });
    }
  }

  function isAuthorized(message) {
    if (!message?.chat?.id || !message?.from?.id) {
      return false;
    }
    if (String(message.chat.id) !== config.allowedChatId) {
      return false;
    }
    if (config.allowedUserId && String(message.from.id) !== config.allowedUserId) {
      return false;
    }
    return true;
  }

  function parseIncomingText(text) {
    const raw = String(text || "").trim();
    if (!raw) {
      return { type: "empty", raw, body: "" };
    }

    const commandMatch = raw.match(/^\/([a-zA-Z0-9_]+)(?:@[\w_]+)?(?:\s+([\s\S]*))?$/);
    if (!commandMatch) {
      return { type: "spicy_run", raw, prompt: raw };
    }

    const command = commandMatch[1].toLowerCase();
    const body = (commandMatch[2] || "").trim();

    if (command === "start" || command === "help") {
      return { type: "spicy_help", raw, body };
    }

    if (command === "spicy") {
      return parseSpicyBody(raw, body);
    }

    if (command === "codex") {
      return { type: "spicy_run", raw, prompt: body };
    }

    if (command === "codex_status" || command === "status") {
      return { type: "spicy_status", raw, body };
    }

    if (command === "codex_stop") {
      return { type: "spicy_stop", raw, body };
    }

    return { type: "spicy_run", raw, prompt: raw };
  }

  function parseSpicyBody(raw, body) {
    if (!body) {
      return { type: "spicy_help", raw, body };
    }

    const [first, ...restParts] = body.split(/\s+/);
    const subcommand = first.toLowerCase();
    const rest = restParts.join(" ").trim();

    switch (subcommand) {
      case "help":
        return { type: "spicy_help", raw, body: rest };
      case "status":
        return { type: "spicy_status", raw, body: rest };
      case "stop":
        return { type: "spicy_stop", raw, body: rest };
      case "project":
        return { type: "spicy_project", raw, project: rest };
      case "mode":
        return { type: "spicy_mode", raw, mode: rest.toLowerCase() };
      case "logs":
        return { type: "spicy_logs", raw, body: rest };
      case "diff":
        return { type: "spicy_diff", raw, body: rest };
      case "doctor":
        return { type: "spicy_doctor", raw, body: rest };
      case "shell":
        return { type: "spicy_shell", raw, command: rest };
      case "run":
        return { type: "spicy_run", raw, prompt: rest };
      default:
        return { type: "spicy_run", raw, prompt: body };
    }
  }

  function buildExecSpec(mode, prompt, cwd) {
    if (config.execSpecBuilder) {
      return config.execSpecBuilder({
        mode,
        prompt,
        cwd,
        model: config.model,
      });
    }

    const sandbox = mode === "fast" ? config.fastSandbox : config.safeSandbox;
    const args = ["--ask-for-approval", "never", "--sandbox", sandbox];

    if (config.model) {
      args.push("--model", config.model);
    }

    const finalPrompt =
      mode === "safe" ? `${SAFE_PROMPT_PREFIX}\n\n${prompt}` : prompt;
    args.push("exec", "--skip-git-repo-check", "--cd", cwd, finalPrompt);

    return {
      command: "codex",
      args,
      envOverrides: {},
      sandbox,
    };
  }

  function formatFilesChanged(filesChanged) {
    if (!filesChanged || filesChanged.length === 0) {
      return "none";
    }
    return filesChanged.join(", ");
  }

  function summarizeResult(result) {
    if (result.stopped) {
      return "stopped";
    }
    if (result.timedOut) {
      return "timed out";
    }
    if (result.signal) {
      return `signal ${result.signal}`;
    }
    return `exit ${result.exitCode ?? "unknown"}`;
  }

  function startRun(message, prompt) {
    const cwd = activeProjectPath();
    const beforeState = snapshotRepoState(cwd);
    const spec = buildExecSpec(state.currentMode, prompt, cwd);
    const run = {
      kind: "spicy",
      chatId: message.chat.id,
      sender: senderInfo(message),
      prompt,
      promptSummary: summarizeText(prompt),
      startedAt: Date.now(),
      project: state.currentProject,
      cwd,
      mode: state.currentMode,
      child: null,
      timedOut: false,
      stopRequested: false,
      output: "",
      beforeState,
    };

    state.activeRun = run;
    logAction({
      event: "start",
      sender: run.sender,
      promptSummary: run.promptSummary,
      cwd: run.cwd,
    });

    const child = config.spawnImpl(spec.command, spec.args, {
      cwd,
      env: { ...process.env, ...(spec.envOverrides || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    run.child = child;

    child.stdout.on("data", (chunk) => {
      run.output += chunk.toString("utf8");
      if (run.output.length > MAX_OUTPUT_CAPTURE) {
        run.output = run.output.slice(-MAX_OUTPUT_CAPTURE);
      }
    });

    child.stderr.on("data", (chunk) => {
      run.output += chunk.toString("utf8");
      if (run.output.length > MAX_OUTPUT_CAPTURE) {
        run.output = run.output.slice(-MAX_OUTPUT_CAPTURE);
      }
    });

    const timer = setTimeout(() => {
      run.timedOut = true;
      if (run.child) {
        run.child.kill("SIGTERM");
        setTimeout(() => {
          if (run.child) {
            run.child.kill("SIGKILL");
          }
        }, 5000).unref();
      }
    }, config.commandTimeoutMs);

    const finalize = async (result) => {
      if (run.finalized) {
        return;
      }
      run.finalized = true;
      clearTimeout(timer);
      if (state.activeRun === run) {
        state.activeRun = null;
      }

      const afterState = snapshotRepoState(cwd);
      const filesChanged = diffRepoState(beforeState, afterState);
      state.lastRun = {
        project: run.project,
        mode: run.mode,
        cwd: run.cwd,
        promptSummary: run.promptSummary,
        finishedAt: new Date().toISOString(),
        filesChanged,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        stopped: result.stopped,
      };

      if (!result.stopped && (result.exitCode !== 0 || result.signal || result.timedOut)) {
        state.lastError = `${new Date().toISOString()} ${summarizeResult(result)} ${run.promptSummary}`;
      }

      logAction({
        event: result.error ? "error" : "finish",
        sender: run.sender,
        promptSummary: run.promptSummary,
        cwd: run.cwd,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        stopped: result.stopped,
        filesChanged,
      });

      const header = [
        `Spicy run finished on ${run.project}`,
        `Mode: ${run.mode}`,
        `Status: ${summarizeResult(result)}`,
        `Files changed: ${formatFilesChanged(filesChanged)}`,
      ].join("\n");

      const output = run.output.trim();
      const messageText = output ? `${header}\n\n${output}` : header;
      try {
        await sendMessage(run.chatId, messageText);
      } catch (error) {
        logAction({
          event: "error",
          sender: run.sender,
          promptSummary: `finish-notify ${run.promptSummary}`,
          cwd: run.cwd,
          exitCode: 1,
          filesChanged: [],
          error: error.message,
        });
      }
    };

    child.once("error", async (error) => {
      await finalize({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stopped: false,
        error,
      });
    });

    child.once("close", async (code, signal) => {
      await finalize({
        exitCode: code,
        signal,
        timedOut: run.timedOut,
        stopped: run.stopRequested,
      });
    });

    return run;
  }

  function parseShellCommand(command) {
    const trimmed = String(command || "").trim();
    if (!trimmed) {
      return { error: "Usage:\n/spicy shell <allowed command>" };
    }

    if (trimmed === "pwd") {
      return { command: "pwd", args: [], preview: "pwd" };
    }
    if (trimmed === "ls") {
      return { command: "ls", args: [], preview: "ls" };
    }
    if (trimmed === "git status") {
      return { command: "git", args: ["status"], preview: "git status" };
    }
    if (trimmed === "./spicywhite_ctl.sh status") {
      return {
        command: path.join(activeProjectPath(), "spicywhite_ctl.sh"),
        args: ["status"],
        preview: "./spicywhite_ctl.sh status",
      };
    }
    if (trimmed === "./spicywhite_ctl.sh doctor") {
      return {
        command: path.join(activeProjectPath(), "spicywhite_ctl.sh"),
        args: ["doctor"],
        preview: "./spicywhite_ctl.sh doctor",
      };
    }

    const tailMatch = trimmed.match(/^tail(?:\s+-n\s+(\d+))?\s+([a-z]+)$/);
    if (tailMatch) {
      const lines = Math.min(Number(tailMatch[1] || 50), MAX_TAIL_LINES);
      const name = tailMatch[2].toLowerCase();
      if (!knownLogs[name]) {
        return {
          error: `Unknown log '${name}'. Allowed logs: ${Object.keys(knownLogs).join(", ")}`,
        };
      }
      return {
        command: "tail",
        args: ["-n", String(lines), knownLogs[name]],
        preview: `tail -n ${lines} ${name}`,
      };
    }

    return {
      error: [
        "Shell is allowlist-only.",
        "Allowed commands:",
        "pwd",
        "ls",
        "git status",
        "./spicywhite_ctl.sh status",
        "./spicywhite_ctl.sh doctor",
        "tail [-n N] bot|web|telegram|errors",
      ].join("\n"),
    };
  }

  function tailFile(filePath, lines = 50) {
    const result = config.spawnSyncImpl("tail", ["-n", String(lines), filePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return result.stdout || result.stderr || "(no output)";
  }

  async function getWebHealthSummary() {
    if (!config.fetchImpl) {
      return "unknown (fetch unavailable)";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await config.fetchImpl(config.webHealthUrl, {
        signal: controller.signal,
      });
      return response.ok ? `ok (${response.status})` : `http ${response.status}`;
    } catch (error) {
      return `down (${error.message})`;
    } finally {
      clearTimeout(timer);
    }
  }

  function getLastSnapshotPath() {
    if (!fs.existsSync(config.snapshotDir)) {
      return "none";
    }

    const entries = fs
      .readdirSync(config.snapshotDir)
      .filter((name) => name.startsWith("spicywhite_continuity_") && name.endsWith(".tgz"))
      .map((name) => {
        const fullPath = path.join(config.snapshotDir, name);
        return {
          fullPath,
          mtimeMs: fs.statSync(fullPath).mtimeMs,
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    return entries[0]?.fullPath || "none";
  }

  async function handleSpicyRun(message, prompt) {
    if (!prompt) {
      await sendMessage(
        message.chat.id,
        "Usage:\n/spicy <prompt>\n/spicy run <prompt>",
      );
      return;
    }

    if (state.activeRun) {
      logAction({
        event: "rejected_busy",
        sender: senderInfo(message),
        promptSummary: summarizeText(prompt),
        cwd: state.activeRun.cwd,
        exitCode: 1,
        filesChanged: [],
      });
      await sendMessage(
        message.chat.id,
        "A spicy run is already active. Use /spicy status or /spicy stop.",
      );
      return;
    }

    const run = startRun(message, prompt);
    await sendMessage(
      message.chat.id,
      [
        "ACK: spicy run started",
        `Project: ${run.project}`,
        `Mode: ${run.mode}`,
        `CWD: ${run.cwd}`,
        `Prompt: ${run.promptSummary}`,
        "Use /spicy status, /spicy stop, /spicy diff, or /spicy doctor.",
      ].join("\n"),
    );
  }

  async function handleSpicyStatus(message) {
    if (!state.activeRun) {
      await sendMessage(
        message.chat.id,
        [
          "Status: idle",
          `Project: ${state.currentProject}`,
          `Mode: ${state.currentMode}`,
          `Last run: ${state.lastRun ? state.lastRun.promptSummary : "none"}`,
        ].join("\n"),
      );
      return;
    }

    const ageSec = Math.floor((Date.now() - state.activeRun.startedAt) / 1000);
    await sendMessage(
      message.chat.id,
      [
        "Status: running",
        `Project: ${state.activeRun.project}`,
        `Mode: ${state.activeRun.mode}`,
        `Running for: ${ageSec}s`,
        `Prompt: ${state.activeRun.promptSummary}`,
      ].join("\n"),
    );
  }

  async function handleSpicyStop(message) {
    if (!state.activeRun?.child) {
      await sendMessage(message.chat.id, "No active spicy run.");
      return;
    }

    state.activeRun.stopRequested = true;
    state.activeRun.child.kill("SIGTERM");
    setTimeout(() => {
      if (state.activeRun?.child) {
        state.activeRun.child.kill("SIGKILL");
      }
    }, 5000).unref();

    logAction({
      event: "stop",
      sender: senderInfo(message),
      promptSummary: state.activeRun.promptSummary,
      cwd: state.activeRun.cwd,
      exitCode: 0,
      filesChanged: [],
    });

    await sendMessage(message.chat.id, "Stop requested for the active spicy run.");
  }

  async function handleSpicyHelp(message) {
    await sendMessage(
      message.chat.id,
      [
        "Spicy v2 commands:",
        "/spicy <prompt>        Run Codex on the active project",
        "/spicy run <prompt>    Explicit run form",
        "/spicy status          Show running or idle state",
        "/spicy stop            Stop the active Codex process",
        "/spicy help            Show command help",
        "/spicy project <name>  Switch project: clawbot, dual-caption, saas_test, milestone_test",
        "/spicy mode <safe|fast> Change execution mode",
        "/spicy logs            Tail the Telegram bridge log",
        "/spicy diff            Show changed files from the last run",
        "/spicy doctor          Show operator health summary",
        "/spicy shell <cmd>     Optional allowlisted shell only",
      ].join("\n"),
    );
  }

  async function handleSpicyProject(message, project) {
    if (!project) {
      await sendMessage(
        message.chat.id,
        `Usage:\n/spicy project <${Object.keys(config.projectMap).join("|")}>`,
      );
      return;
    }

    if (state.activeRun) {
      await sendMessage(message.chat.id, "Cannot change project while a spicy run is active.");
      return;
    }

    if (!config.projectMap[project]) {
      await sendMessage(
        message.chat.id,
        `Unknown project '${project}'. Allowed: ${Object.keys(config.projectMap).join(", ")}`,
      );
      return;
    }

    state.currentProject = project;
    logAction({
      event: "project",
      sender: senderInfo(message),
      promptSummary: project,
      cwd: activeProjectPath(),
      exitCode: 0,
      filesChanged: [],
    });
    await sendMessage(
      message.chat.id,
      `Active project set to ${project}\nCWD: ${activeProjectPath()}`,
    );
  }

  async function handleSpicyMode(message, mode) {
    if (mode !== "safe" && mode !== "fast") {
      await sendMessage(message.chat.id, "Usage:\n/spicy mode safe\n/spicy mode fast");
      return;
    }

    state.currentMode = mode;
    logAction({
      event: "mode",
      sender: senderInfo(message),
      promptSummary: mode,
      cwd: activeProjectPath(),
      exitCode: 0,
      filesChanged: [],
    });

    const sandbox = mode === "fast" ? config.fastSandbox : config.safeSandbox;
    await sendMessage(
      message.chat.id,
      `Mode set to ${mode}\nSandbox: ${sandbox}\nBypass: false`,
    );
  }

  async function handleSpicyLogs(message) {
    const output = fs.existsSync(config.logPath)
      ? tailFile(config.logPath, 50)
      : `Log file not found: ${config.logPath}`;
    await sendMessage(
      message.chat.id,
      [`Log: ${config.logPath}`, output.trim()].join("\n\n"),
    );
  }

  async function handleSpicyDiff(message) {
    if (!state.lastRun) {
      await sendMessage(message.chat.id, "No previous spicy run recorded.");
      return;
    }

    await sendMessage(
      message.chat.id,
      [
        `Last run project: ${state.lastRun.project}`,
        `Prompt: ${state.lastRun.promptSummary}`,
        `Files changed: ${formatFilesChanged(state.lastRun.filesChanged)}`,
      ].join("\n"),
    );
  }

  async function handleSpicyDoctor(message) {
    const webHealth = await getWebHealthSummary();
    const lastSnapshot = getLastSnapshotPath();
    const running = state.activeRun ? "running" : "idle";
    const lines = [
      `Active project: ${state.currentProject}`,
      `Mode: ${state.currentMode}`,
      `State: ${running}`,
      `SpicyWhite web health: ${webHealth}`,
      `Last error: ${state.lastError}`,
      `Last snapshot path: ${lastSnapshot}`,
    ];

    if (state.activeRun) {
      lines.push(`Active prompt: ${state.activeRun.promptSummary}`);
    }
    if (state.lastRun) {
      lines.push(`Last changed files: ${formatFilesChanged(state.lastRun.filesChanged)}`);
    }

    await sendMessage(message.chat.id, lines.join("\n"));
  }

  async function handleSpicyShell(message, command) {
    if (!config.shellEnabled) {
      await sendMessage(message.chat.id, "Shell is disabled. Set TELEGRAM_ENABLE_SHELL=true to enable allowlisted shell.");
      return;
    }

    const parsed = parseShellCommand(command);
    if (parsed.error) {
      await sendMessage(message.chat.id, parsed.error);
      return;
    }

    const beforeState = snapshotRepoState(activeProjectPath());
    const result = config.spawnSyncImpl(parsed.command, parsed.args, {
      cwd: activeProjectPath(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const afterState = snapshotRepoState(activeProjectPath());
    const filesChanged = diffRepoState(beforeState, afterState);
    const output = (result.stdout || result.stderr || "(no output)").trim();

    logAction({
      event: "finish",
      sender: senderInfo(message),
      promptSummary: parsed.preview,
      cwd: activeProjectPath(),
      exitCode: result.status,
      filesChanged,
    });

    await sendMessage(
      message.chat.id,
      [
        `Shell command: ${parsed.preview}`,
        `Exit: ${result.status}`,
        `Files changed: ${formatFilesChanged(filesChanged)}`,
        "",
        output,
      ].join("\n"),
    );
  }

  async function handleMessage(message) {
    const rawText = String(message?.text || "");
    if (!isAuthorized(message)) {
      logAction({
        event: "error",
        sender: senderInfo(message),
        promptSummary: "unauthorized message",
        cwd: activeProjectPath(),
        exitCode: 1,
        filesChanged: [],
      });
      return;
    }

    const parsed = parseIncomingText(rawText);
    logAction({
      event: "received",
      sender: senderInfo(message),
      promptSummary: summarizeText(rawText),
      cwd: activeProjectPath(),
      exitCode: 0,
      filesChanged: [],
    });

    switch (parsed.type) {
      case "empty":
        return;
      case "spicy_help":
        await handleSpicyHelp(message);
        return;
      case "spicy_status":
        await handleSpicyStatus(message);
        return;
      case "spicy_stop":
        await handleSpicyStop(message);
        return;
      case "spicy_project":
        await handleSpicyProject(message, parsed.project);
        return;
      case "spicy_mode":
        await handleSpicyMode(message, parsed.mode);
        return;
      case "spicy_logs":
        await handleSpicyLogs(message);
        return;
      case "spicy_diff":
        await handleSpicyDiff(message);
        return;
      case "spicy_doctor":
        await handleSpicyDoctor(message);
        return;
      case "spicy_shell":
        await handleSpicyShell(message, parsed.command);
        return;
      case "spicy_run":
      default:
        await handleSpicyRun(message, parsed.prompt);
    }
  }

  async function handleText(text, senderOverrides = {}) {
    const message = {
      text,
      chat: { id: senderOverrides.chatId ?? Number(config.allowedChatId || 1) },
      from: {
        id: senderOverrides.userId ?? Number(config.allowedUserId || config.allowedChatId || 1),
        username: senderOverrides.username || "local-test",
        first_name: senderOverrides.firstName || "Local",
        last_name: senderOverrides.lastName || "Test",
      },
    };
    await handleMessage(message);
  }

  async function fetchUpdates() {
    return telegram("getUpdates", {
      offset: state.offset,
      timeout: config.pollTimeoutSec,
      allowed_updates: ["message"],
    });
  }

  async function bootstrapOffset() {
    if (!config.skipOldUpdates) {
      return;
    }
    const updates = await telegram("getUpdates", {
      timeout: 0,
      allowed_updates: ["message"],
    });
    if (updates.length) {
      state.offset = Math.max(...updates.map((item) => item.update_id)) + 1;
    }
  }

  async function pollLoop() {
    if (!config.botToken) {
      throw new Error("Missing TELEGRAM_BOT_TOKEN");
    }
    if (!config.allowedChatId) {
      throw new Error("Missing TELEGRAM_ALLOWED_CHAT_ID");
    }

    logAction({
      event: "start",
      sender: { chatId: null, userId: null },
      promptSummary: "bridge startup",
      cwd: activeProjectPath(),
      exitCode: 0,
      filesChanged: [],
    });

    await bootstrapOffset();

    while (true) {
      try {
        const updates = await fetchUpdates();
        for (const update of updates) {
          state.offset = update.update_id + 1;
          if (update.message?.text) {
            await handleMessage(update.message);
          }
        }
      } catch (error) {
        state.lastError = `${new Date().toISOString()} ${error.message}`;
        logAction({
          event: "error",
          sender: { chatId: null, userId: null },
          promptSummary: `poll loop: ${error.message}`,
          cwd: activeProjectPath(),
          exitCode: 1,
          filesChanged: [],
        });
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  function getState() {
    return {
      currentProject: state.currentProject,
      currentMode: state.currentMode,
      activeRun: state.activeRun
        ? {
            project: state.activeRun.project,
            mode: state.activeRun.mode,
            promptSummary: state.activeRun.promptSummary,
          }
        : null,
      lastRun: state.lastRun,
      lastError: state.lastError,
      logPath: config.logPath,
    };
  }

  return {
    handleMessage,
    handleText,
    pollLoop,
    getState,
    config,
  };
}

async function main() {
  const bridge = createBridge();
  console.log("Telegram spicy v2 bridge starting", {
    project: bridge.getState().currentProject,
    mode: bridge.getState().currentMode,
    logPath: bridge.config.logPath,
  });
  await bridge.pollLoop();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  createBridge,
  DEFAULT_PROJECTS,
};
