#!/usr/bin/env node

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

loadDotEnv(path.join(process.cwd(), ".env"));

const DEFAULT_WORKDIR = "/Users/alfredmunoz/clawbot";
const BOT_LOG_PATH = path.resolve(
  expandHome(
    process.env.TELEGRAM_BOT_LOG_PATH ||
      "~/.spicywhite/logs/telegram-codex-bot.log",
  ),
);
const TELEGRAM_BOT_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");
const TELEGRAM_ALLOWED_CHAT_ID = requireEnv("TELEGRAM_ALLOWED_CHAT_ID");
const TELEGRAM_ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID || "";
const TELEGRAM_WORKDIR = path.resolve(
  expandHome(process.env.TELEGRAM_WORKDIR || DEFAULT_WORKDIR),
);
const TELEGRAM_ALLOWED_ROOTS = (
  process.env.TELEGRAM_ALLOWED_ROOTS || TELEGRAM_WORKDIR
)
  .split(":")
  .map((item) => path.resolve(expandHome(item.trim())))
  .filter(Boolean);
const TELEGRAM_POLL_TIMEOUT_SEC = Number(
  process.env.TELEGRAM_POLL_TIMEOUT_SEC || 30,
);
const TELEGRAM_COMMAND_TIMEOUT_MS = Number(
  process.env.TELEGRAM_COMMAND_TIMEOUT_MS || 15 * 60 * 1000,
);
const TELEGRAM_ENABLE_SHELL =
  String(process.env.TELEGRAM_ENABLE_SHELL || "false").toLowerCase() === "true";
const TELEGRAM_SKIP_OLD_UPDATES =
  String(process.env.TELEGRAM_SKIP_OLD_UPDATES || "true").toLowerCase() ===
  "true";
const CODEX_MODEL = process.env.CODEX_MODEL || "";
const CODEX_SAFE_SANDBOX = process.env.CODEX_SAFE_SANDBOX || "workspace-write";
const CODEX_SAFE_BYPASS =
  String(process.env.CODEX_SAFE_BYPASS || "false").toLowerCase() === "true";
const CODEX_FAST_SANDBOX =
  process.env.CODEX_FAST_SANDBOX || process.env.CODEX_SANDBOX || "danger-full-access";
const CODEX_FAST_BYPASS =
  String(
    process.env.CODEX_FAST_BYPASS ?? process.env.CODEX_BYPASS ?? "false",
  ).toLowerCase() === "true";
const CODEX_DEFAULT_MODE =
  String(process.env.CODEX_DEFAULT_MODE || "safe").toLowerCase() === "fast"
    ? "fast"
    : "safe";

const TELEGRAM_API_BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const MAX_TELEGRAM_MESSAGE = 3500;
const MAX_OUTPUT_CAPTURE = 120000;
const MAX_TAIL_LINES = 200;
const KNOWN_LOGS = {
  bot: BOT_LOG_PATH,
  web: path.resolve(
    expandHome(
      process.env.TELEGRAM_TAIL_WEB_LOG || "~/.spicywhite/logs/web-console.log",
    ),
  ),
  telegram: path.resolve(
    expandHome(
      process.env.TELEGRAM_TAIL_TELEGRAM_LOG ||
        "~/.spicywhite/logs/telegram-console.log",
    ),
  ),
  errors: path.resolve(
    expandHome(
      process.env.TELEGRAM_TAIL_ERRORS_LOG || "~/.spicywhite/logs/bot.errors.log",
    ),
  ),
};

let offset = 0;
let activeRun = null;
let currentCodexMode = CODEX_DEFAULT_MODE;

bootstrapFilesystem();

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

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
  if (!value.startsWith("~")) {
    return value;
  }
  return path.join(os.homedir(), value.slice(1));
}

function bootstrapFilesystem() {
  fs.mkdirSync(path.dirname(BOT_LOG_PATH), { recursive: true });

  if (!fs.existsSync(TELEGRAM_WORKDIR) || !fs.statSync(TELEGRAM_WORKDIR).isDirectory()) {
    console.error(`Configured TELEGRAM_WORKDIR does not exist: ${TELEGRAM_WORKDIR}`);
    process.exit(1);
  }

  if (!isPathWithinRoots(TELEGRAM_WORKDIR)) {
    console.error(
      `TELEGRAM_WORKDIR must be inside TELEGRAM_ALLOWED_ROOTS: ${TELEGRAM_WORKDIR}`,
    );
    process.exit(1);
  }
}

function isPathWithinRoots(targetPath) {
  const normalized = path.resolve(targetPath);
  return TELEGRAM_ALLOWED_ROOTS.some((root) => {
    const relative = path.relative(root, normalized);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkText(text, size = MAX_TELEGRAM_MESSAGE) {
  if (!text) {
    return ["(no output)"];
  }

  const chunks = [];
  let remaining = String(text);

  while (remaining.length > size) {
    let splitAt = remaining.lastIndexOf("\n", size);
    if (splitAt < size * 0.5) {
      splitAt = size;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }

  if (remaining.length) {
    chunks.push(remaining);
  }

  return chunks;
}

function logAction(entry) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    workdir: TELEGRAM_WORKDIR,
    mode: currentCodexMode,
    ...entry,
  });
  fs.appendFileSync(BOT_LOG_PATH, `${line}\n`);
}

function snapshotRepoState(cwd) {
  const result = spawnSync(
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

  const state = new Map();
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const status = line.slice(0, 2);
    const file = line.slice(3).trim();
    state.set(file, status);
  }
  return state;
}

function diffRepoState(before, after) {
  if (!before || !after) {
    return [];
  }

  const files = new Set([...before.keys(), ...after.keys()]);
  return [...files].filter((file) => before.get(file) !== after.get(file)).sort();
}

async function telegram(method, payload) {
  const response = await fetch(`${TELEGRAM_API_BASE}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`${method} failed: ${JSON.stringify(data)}`);
  }
  return data.result;
}

async function sendMessage(chatId, text) {
  for (const chunk of chunkText(text)) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
    });
  }
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

function isAuthorized(message) {
  if (!message?.chat?.id || !message?.from?.id) {
    return false;
  }

  if (String(message.chat.id) !== String(TELEGRAM_ALLOWED_CHAT_ID)) {
    return false;
  }

  if (
    TELEGRAM_ALLOWED_USER_ID &&
    String(message.from.id) !== String(TELEGRAM_ALLOWED_USER_ID)
  ) {
    return false;
  }

  return true;
}

function parseIncomingText(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return { type: "empty", body: "" };
  }

  const commandMatch = raw.match(/^\/([a-zA-Z0-9_]+)(?:@[\w_]+)?(?:\s+([\s\S]*))?$/);
  if (!commandMatch) {
    return { type: "codex", body: raw, raw };
  }

  const command = commandMatch[1].toLowerCase();
  const body = (commandMatch[2] || "").trim();

  if (command === "start" || command === "help") {
    return { type: "help", body, raw };
  }
  if (command === "status" || command === "codex_status") {
    return { type: "codex_status", body, raw };
  }
  if (command === "codex_stop") {
    return { type: "codex_stop", body, raw };
  }
  if (command === "codex_tail") {
    return { type: "codex_tail", body, raw };
  }
  if (command === "codex_mode") {
    return { type: "codex_mode", body, raw };
  }
  if (command === "codex_plan") {
    return { type: "codex_plan", body, raw };
  }
  if (command === "codex") {
    return { type: "codex", body, raw };
  }
  if (command === "sh") {
    return { type: "shell", body, raw };
  }

  return { type: "codex", body: raw, raw };
}

function buildCodexInvocation(mode, prompt) {
  const args = [];
  let sandbox = CODEX_SAFE_SANDBOX;
  let bypass = CODEX_SAFE_BYPASS;
  let planPrefix = "";
  let envOverrides = {};

  if (mode === "fast") {
    sandbox = CODEX_FAST_SANDBOX;
    bypass = CODEX_FAST_BYPASS;
  }

  if (mode === "plan") {
    sandbox = "read-only";
    bypass = false;
    planPrefix =
      "Plan-only mode. Do not run shell commands. Do not edit files. Do not apply patches. Respond with a concise execution plan only.";
    envOverrides = {
      SHELL: "/usr/bin/false",
      COMSPEC: "/usr/bin/false",
    };
  }

  if (bypass) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--ask-for-approval", "never", "--sandbox", sandbox);
  }

  if (CODEX_MODEL) {
    args.push("--model", CODEX_MODEL);
  }

  const finalPrompt = planPrefix ? `${planPrefix}\n\n${prompt}` : prompt;
  args.push("exec", "--skip-git-repo-check", "--cd", TELEGRAM_WORKDIR, finalPrompt);

  return { args, envOverrides, sandbox: bypass ? "bypass" : sandbox };
}

function startRun(meta) {
  const run = {
    ...meta,
    startedAt: Date.now(),
    child: null,
    stopRequested: false,
  };
  activeRun = run;
  return run;
}

function finishRun(run) {
  if (activeRun === run) {
    activeRun = null;
  }
}

function runProcess({ label, command, args, cwd, envOverrides, run }) {
  return new Promise((resolve) => {
    const beforeState = snapshotRepoState(cwd);
    let finished = false;
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...envOverrides },
      stdio: ["ignore", "pipe", "pipe"],
    });

    run.child = child;

    let combined = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, TELEGRAM_COMMAND_TIMEOUT_MS);

    const onData = (chunk) => {
      combined += chunk.toString("utf8");
      if (combined.length > MAX_OUTPUT_CAPTURE) {
        combined = combined.slice(-MAX_OUTPUT_CAPTURE);
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("error", (error) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      const afterState = snapshotRepoState(cwd);
      resolve({
        label,
        code: null,
        signal: null,
        timedOut: false,
        output: `Failed to start process: ${error.message}`,
        filesChanged: diffRepoState(beforeState, afterState),
      });
    });

    child.on("close", (code, signal) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      const afterState = snapshotRepoState(cwd);
      resolve({
        label,
        code,
        signal,
        timedOut,
        output: combined.trim(),
        filesChanged: diffRepoState(beforeState, afterState),
      });
    });
  });
}

function summarizeResult(result) {
  if (result.timedOut) {
    return "timed out";
  }
  if (result.signal) {
    return `signal ${result.signal}`;
  }
  return `exit ${result.code ?? "unknown"}`;
}

function ensurePrompt(prompt, usageText) {
  if (!prompt) {
    return usageText;
  }
  return null;
}

async function handleCodex(message, prompt, mode) {
  const usage = ensurePrompt(
    prompt,
    mode === "plan" ? "Usage:\n/codex_plan <prompt>" : "Usage:\n/codex <prompt>",
  );
  if (usage) {
    logAction({
      event: "run_complete",
      kind: mode === "plan" ? "codex_plan" : "codex",
      sender: senderInfo(message),
      prompt,
      cwd: TELEGRAM_WORKDIR,
      exitCode: 1,
      filesChanged: [],
    });
    await sendMessage(message.chat.id, usage);
    return;
  }

  const invocation = buildCodexInvocation(mode, prompt);
  const preview = [
    "codex",
    ...invocation.args.slice(0, invocation.args.length - 1),
    JSON.stringify(prompt),
  ].join(" ");
  const run = startRun({
    kind: mode === "plan" ? "codex_plan" : "codex",
    preview,
    requested: prompt,
    sender: senderInfo(message),
  });

  await sendMessage(
    message.chat.id,
    `Running ${run.kind} in ${TELEGRAM_WORKDIR}\nMode: ${mode}\nSandbox: ${invocation.sandbox}`,
  );

  const result = await runProcess({
    label: run.kind,
    command: "codex",
    args: invocation.args,
    cwd: TELEGRAM_WORKDIR,
    envOverrides: invocation.envOverrides,
    run,
  });
  finishRun(run);

  logAction({
    event: "run_complete",
    kind: run.kind,
    sender: run.sender,
    prompt,
    cwd: TELEGRAM_WORKDIR,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    filesChanged: result.filesChanged,
  });

  const changedLine = result.filesChanged.length
    ? `\nFiles changed: ${result.filesChanged.join(", ")}`
    : "\nFiles changed: none";
  await sendMessage(
    message.chat.id,
    `${result.output || "(no output)"}\n\nStatus: ${summarizeResult(result)}${changedLine}`,
  );
}

function parseShellRequest(body) {
  const trimmed = String(body || "").trim();
  if (!trimmed) {
    return { error: "Usage:\n/sh <allowed command>" };
  }

  if (trimmed === "ls") {
    return {
      preview: "ls",
      command: "ls",
      args: [],
    };
  }

  if (trimmed === "pwd") {
    return {
      preview: "pwd",
      command: "pwd",
      args: [],
    };
  }

  if (trimmed === "git status") {
    return {
      preview: "git status",
      command: "git",
      args: ["status"],
    };
  }

  if (trimmed === "./spicywhite_ctl.sh status") {
    return {
      preview: "./spicywhite_ctl.sh status",
      command: path.join(TELEGRAM_WORKDIR, "spicywhite_ctl.sh"),
      args: ["status"],
    };
  }

  const tailMatch = trimmed.match(/^tail(?:\s+-n\s+(\d+))?\s+([a-z]+)$/);
  if (tailMatch) {
    const lines = Math.min(Number(tailMatch[1] || 50), MAX_TAIL_LINES);
    const logName = tailMatch[2].toLowerCase();
    const logPath = KNOWN_LOGS[logName];

    if (!logPath) {
      return {
        error: `Unknown log '${logName}'. Allowed logs: ${Object.keys(KNOWN_LOGS).join(", ")}`,
      };
    }

    return {
      preview: `tail -n ${lines} ${logName}`,
      command: "tail",
      args: ["-n", String(lines), logPath],
    };
  }

  return {
    error: [
      "Shell allowlist only.",
      "Allowed commands:",
      "ls",
      "pwd",
      "git status",
      "./spicywhite_ctl.sh status",
      "tail [-n N] bot|web|telegram|errors",
    ].join("\n"),
  };
}

async function handleShell(message, body) {
  if (!TELEGRAM_ENABLE_SHELL) {
    logAction({
      event: "run_complete",
      kind: "shell",
      sender: senderInfo(message),
      command: body,
      cwd: TELEGRAM_WORKDIR,
      exitCode: 1,
      filesChanged: [],
    });
    await sendMessage(message.chat.id, "Shell execution is disabled.");
    return;
  }

  const parsed = parseShellRequest(body);
  if (parsed.error) {
    logAction({
      event: "run_complete",
      kind: "shell",
      sender: senderInfo(message),
      command: body,
      cwd: TELEGRAM_WORKDIR,
      exitCode: 1,
      filesChanged: [],
    });
    await sendMessage(message.chat.id, parsed.error);
    return;
  }

  const run = startRun({
    kind: "shell",
    preview: parsed.preview,
    requested: body,
    sender: senderInfo(message),
  });

  await sendMessage(
    message.chat.id,
    `Running allowlisted shell command in ${TELEGRAM_WORKDIR}\n\n${parsed.preview}`,
  );

  const result = await runProcess({
    label: "shell",
    command: parsed.command,
    args: parsed.args,
    cwd: TELEGRAM_WORKDIR,
    envOverrides: {},
    run,
  });
  finishRun(run);

  logAction({
    event: "run_complete",
    kind: "shell",
    sender: run.sender,
    command: parsed.preview,
    cwd: TELEGRAM_WORKDIR,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    filesChanged: result.filesChanged,
  });

  const changedLine = result.filesChanged.length
    ? `\nFiles changed: ${result.filesChanged.join(", ")}`
    : "\nFiles changed: none";
  await sendMessage(
    message.chat.id,
    `${result.output || "(no output)"}\n\nStatus: ${summarizeResult(result)}${changedLine}`,
  );
}

async function handleCodexStatus(chatId) {
  if (!activeRun) {
    logAction({
      event: "status",
      kind: "codex_status",
      sender: { chatId, userId: null },
      command: "idle",
      cwd: TELEGRAM_WORKDIR,
      exitCode: 0,
      filesChanged: [],
    });
    await sendMessage(
      chatId,
      [
        "Idle",
        `Mode: ${currentCodexMode}`,
        `Workdir: ${TELEGRAM_WORKDIR}`,
        `Shell allowlist enabled: ${TELEGRAM_ENABLE_SHELL}`,
        `Audit log: ${BOT_LOG_PATH}`,
      ].join("\n"),
    );
    return;
  }

  const ageSec = Math.floor((Date.now() - activeRun.startedAt) / 1000);
  logAction({
    event: "status",
    kind: "codex_status",
    sender: { chatId, userId: null },
    command: activeRun.preview,
    cwd: TELEGRAM_WORKDIR,
    exitCode: 0,
    filesChanged: [],
  });
  await sendMessage(
    chatId,
    [
      "Busy",
      `Mode: ${currentCodexMode}`,
      `Kind: ${activeRun.kind}`,
      `Running for: ${ageSec}s`,
      `Preview: ${activeRun.preview}`,
    ].join("\n"),
  );
}

async function handleCodexStop(message) {
  if (!activeRun?.child) {
    logAction({
      event: "stop_requested",
      kind: "codex_stop",
      sender: senderInfo(message),
      command: "no_active_run",
      cwd: TELEGRAM_WORKDIR,
      exitCode: 0,
      filesChanged: [],
    });
    await sendMessage(message.chat.id, "No active run.");
    return;
  }

  activeRun.stopRequested = true;
  activeRun.child.kill("SIGTERM");
  setTimeout(() => {
    if (activeRun?.child) {
      activeRun.child.kill("SIGKILL");
    }
  }, 5000).unref();

  logAction({
    event: "stop_requested",
    kind: activeRun.kind,
    sender: senderInfo(message),
    requested: activeRun.requested,
    cwd: TELEGRAM_WORKDIR,
    exitCode: 0,
    filesChanged: [],
  });

  await sendMessage(message.chat.id, `Stop requested for ${activeRun.kind}.`);
}

function parseTailBody(body) {
  const trimmed = String(body || "").trim();
  if (!trimmed) {
    return { name: "bot", lines: 50 };
  }

  const parts = trimmed.split(/\s+/);
  const name = parts[0].toLowerCase();
  const lines = parts[1] ? Math.min(Number(parts[1]), MAX_TAIL_LINES) : 50;

  if (!KNOWN_LOGS[name]) {
    return {
      error: `Unknown log '${name}'. Allowed logs: ${Object.keys(KNOWN_LOGS).join(", ")}`,
    };
  }

  if (!Number.isFinite(lines) || lines <= 0) {
    return { error: "Line count must be a positive integer." };
  }

  return { name, lines };
}

async function handleCodexTail(message, body) {
  const parsed = parseTailBody(body);
  if (parsed.error) {
    logAction({
      event: "tail",
      kind: "codex_tail",
      sender: senderInfo(message),
      command: body,
      cwd: TELEGRAM_WORKDIR,
      exitCode: 1,
      filesChanged: [],
    });
    await sendMessage(message.chat.id, parsed.error);
    return;
  }

  const logPath = KNOWN_LOGS[parsed.name];
  if (!fs.existsSync(logPath)) {
    logAction({
      event: "tail",
      kind: "codex_tail",
      sender: senderInfo(message),
      command: `tail -n ${parsed.lines} ${parsed.name}`,
      cwd: TELEGRAM_WORKDIR,
      exitCode: 1,
      filesChanged: [],
    });
    await sendMessage(message.chat.id, `Log file not found: ${logPath}`);
    return;
  }

  const result = spawnSync("tail", ["-n", String(parsed.lines), logPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  logAction({
    event: "tail",
    kind: "codex_tail",
    sender: senderInfo(message),
    command: `tail -n ${parsed.lines} ${parsed.name}`,
    cwd: TELEGRAM_WORKDIR,
    exitCode: result.status,
    filesChanged: [],
  });

  const output = `${result.stdout || result.stderr || "(no output)"}\n\nSource: ${logPath}`;
  await sendMessage(message.chat.id, output.trim());
}

async function handleCodexMode(message, body) {
  const requested = String(body || "").trim().toLowerCase();
  if (!requested) {
    logAction({
      event: "mode_query",
      kind: "codex_mode",
      sender: senderInfo(message),
      command: currentCodexMode,
      cwd: TELEGRAM_WORKDIR,
      exitCode: 0,
      filesChanged: [],
    });
    await sendMessage(message.chat.id, `Current mode: ${currentCodexMode}`);
    return;
  }

  if (requested !== "safe" && requested !== "fast") {
    logAction({
      event: "mode_change",
      kind: "codex_mode",
      sender: senderInfo(message),
      command: requested,
      cwd: TELEGRAM_WORKDIR,
      exitCode: 1,
      filesChanged: [],
    });
    await sendMessage(message.chat.id, "Usage:\n/codex_mode safe\n/codex_mode fast");
    return;
  }

  currentCodexMode = requested;
  logAction({
    event: "mode_change",
    kind: "codex_mode",
    sender: senderInfo(message),
    command: requested,
    cwd: TELEGRAM_WORKDIR,
    exitCode: 0,
    filesChanged: [],
  });
  await sendMessage(message.chat.id, `Codex mode set to ${currentCodexMode}.`);
}

async function handleHelp(chatId) {
  logAction({
    event: "help",
    kind: "help",
    sender: { chatId, userId: null },
    command: "help",
    cwd: TELEGRAM_WORKDIR,
    exitCode: 0,
    filesChanged: [],
  });
  await sendMessage(
    chatId,
    [
      "Commands:",
      "/codex <prompt>        Run Codex in the current mode",
      "/codex_plan <prompt>   Plan only, with a read-only bridge setup",
      "/codex_status          Show current mode and active run",
      "/codex_stop            Stop the active run",
      "/codex_tail [log] [n]  Tail bot|web|telegram|errors logs",
      "/codex_mode safe|fast  Change Codex execution mode",
      "/sh <command>          Run an allowlisted shell command only",
      "/help                  Show this help",
      "",
      "Plain text messages are treated as /codex prompts.",
    ].join("\n"),
  );
}

async function processMessage(message) {
  const chatId = message.chat.id;
  const rawText = String(message.text || "");

  if (!isAuthorized(message)) {
    logAction({
      event: "unauthorized",
      sender: senderInfo(message),
      command: rawText,
      cwd: TELEGRAM_WORKDIR,
      filesChanged: [],
    });
    console.warn("Ignoring unauthorized Telegram message", senderInfo(message));
    return;
  }

  const parsed = parseIncomingText(rawText);
  logAction({
    event: "received",
    kind: parsed.type,
    sender: senderInfo(message),
    command: rawText,
    cwd: TELEGRAM_WORKDIR,
    filesChanged: [],
  });

  if (parsed.type === "empty") {
    return;
  }

  const canRunWhileBusy = new Set(["help", "codex_status", "codex_stop", "codex_tail", "codex_mode"]);
  if (!canRunWhileBusy.has(parsed.type) && activeRun) {
    logAction({
      event: "rejected_busy",
      kind: parsed.type,
      sender: senderInfo(message),
      command: rawText,
      cwd: TELEGRAM_WORKDIR,
      exitCode: 1,
      filesChanged: [],
    });
    await sendMessage(chatId, "Busy. Use /codex_status or /codex_stop.");
    return;
  }

  if (parsed.type === "help") {
    await handleHelp(chatId);
    return;
  }

  if (parsed.type === "codex_status") {
    await handleCodexStatus(chatId);
    return;
  }

  if (parsed.type === "codex_stop") {
    await handleCodexStop(message);
    return;
  }

  if (parsed.type === "codex_tail") {
    await handleCodexTail(message, parsed.body);
    return;
  }

  if (parsed.type === "codex_mode") {
    await handleCodexMode(message, parsed.body);
    return;
  }

  if (parsed.type === "shell") {
    await handleShell(message, parsed.body);
    return;
  }

  if (parsed.type === "codex_plan") {
    await handleCodex(message, parsed.body, "plan");
    return;
  }

  await handleCodex(message, parsed.body, currentCodexMode);
}

async function fetchUpdates(timeoutSeconds) {
  return telegram("getUpdates", {
    offset,
    timeout: timeoutSeconds,
    allowed_updates: ["message"],
  });
}

async function bootstrapOffset() {
  if (!TELEGRAM_SKIP_OLD_UPDATES) {
    return;
  }

  const updates = await telegram("getUpdates", {
    timeout: 0,
    allowed_updates: ["message"],
  });
  if (updates.length) {
    offset = Math.max(...updates.map((item) => item.update_id)) + 1;
  }
}

async function main() {
  logAction({
    event: "startup",
    kind: "bot",
    sender: { chatId: null, userId: null },
    command: "start",
    cwd: TELEGRAM_WORKDIR,
    filesChanged: [],
    shellEnabled: TELEGRAM_ENABLE_SHELL,
  });

  console.log("Telegram Codex bot starting", {
    workdir: TELEGRAM_WORKDIR,
    mode: currentCodexMode,
    shellEnabled: TELEGRAM_ENABLE_SHELL,
    logPath: BOT_LOG_PATH,
  });

  await bootstrapOffset();

  while (true) {
    try {
      const updates = await fetchUpdates(TELEGRAM_POLL_TIMEOUT_SEC);
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message?.text) {
          await processMessage(update.message);
        }
      }
    } catch (error) {
      logAction({
        event: "poll_error",
        kind: "bot",
        sender: { chatId: null, userId: null },
        command: error.message,
        cwd: TELEGRAM_WORKDIR,
        filesChanged: [],
      });
      console.error("Polling loop error", error);
      await sleep(3000);
    }
  }
}

main().catch((error) => {
  logAction({
    event: "fatal",
    kind: "bot",
    sender: { chatId: null, userId: null },
    command: error.message,
    cwd: TELEGRAM_WORKDIR,
    filesChanged: [],
  });
  console.error(error);
  process.exit(1);
});
