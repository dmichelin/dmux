const { Terminal } = window;
const { FitAddon } = window.FitAddon;

const workspaceEl = document.getElementById("workspace");
const sessionsEl = document.getElementById("sessions");
const newSessionButton = document.getElementById("new-session");
const statusLeftEl = document.getElementById("status-left");
const aiOverlayEl = document.getElementById("ai-overlay");
const aiPromptEl = document.getElementById("ai-prompt");
const aiResultsEl = document.getElementById("ai-results");
const aiMetaEl = document.getElementById("ai-meta");
const aiContextEl = document.getElementById("ai-context");

const PREFIX_TIMEOUT_MS = 1400;
const RESIZE_STEP = 0.05;
const MIN_RATIO = 0.18;
const MAX_CONTEXT_CHARS = 12000;
const terminalRegistry = new Map();
const sessions = new Map();

let activeSessionId = null;
let focusedPaneId = null;
let editingPaneId = null;
let prefixActive = false;
let prefixTimer = null;
let idCounter = 0;
const aiState = {
  open: false,
  paneId: null,
  prompt: "",
  loading: false,
  error: "",
  suggestions: [],
  selectedIndex: 0
};

function normalizeKey(event) {
  if (event.key.length === 1) {
    return event.shiftKey ? event.key.toUpperCase() : event.key.toLowerCase();
  }

  return event.key;
}

function focusPaneTerminal(paneId) {
  if (aiState.open) {
    return;
  }

  if (!paneId) {
    return;
  }

  const state = terminalRegistry.get(paneId);
  if (!state?.terminal) {
    return;
  }

  window.requestAnimationFrame(() => {
    state.terminal.focus();
  });
}

function nextId(prefix) {
  idCounter += 1;
  return `${prefix}-${idCounter.toString(36)}`;
}

function createLeaf(paneId) {
  return {
    type: "leaf",
    paneId
  };
}

function createSplit(axis, first, second, ratio = 0.5) {
  return {
    type: "split",
    axis,
    ratio,
    first,
    second
  };
}

function createSession(name = `session-${sessions.size + 1}`) {
  const paneId = nextId("pane");
  const session = {
    id: nextId("session"),
    name,
    root: createLeaf(paneId),
    paneOrder: [paneId],
    paneNames: {
      [paneId]: "main"
    }
  };

  sessions.set(session.id, session);
  activeSessionId = session.id;
  focusedPaneId = paneId;
  renderChrome();
  ensurePaneTerminal(paneId).then(() => {
    renderSessions();
  });
}

function getActiveSession() {
  return sessions.get(activeSessionId);
}

function ensurePrefixState(active) {
  if (aiState.open && active) {
    return;
  }

  prefixActive = active;
  clearTimeout(prefixTimer);
  prefixTimer = null;

  if (active) {
    prefixTimer = window.setTimeout(() => {
      prefixActive = false;
      renderStatus();
    }, PREFIX_TIMEOUT_MS);
  }

  renderStatus();
}

function consumePrefixCommand(key, event = null) {
  const handled = handlePrefixCommand(key, event);
  if (handled) {
    ensurePrefixState(false);
  }
  return handled;
}

function getPaneLabel(paneId) {
  const session = findSessionContainingPane(paneId);
  return session?.paneNames?.[paneId] || paneId;
}

function getPaneRecentOutput(paneId) {
  return terminalRegistry.get(paneId)?.recentOutput || "";
}

function renderAiOverlay() {
  aiOverlayEl.hidden = !aiState.open;
  if (!aiState.open) {
    return;
  }

  const paneLabel = getPaneLabel(aiState.paneId);
  const terminalState = terminalRegistry.get(aiState.paneId);
  const contextParts = [paneLabel];
  if (terminalState?.cwd) {
    contextParts.push(terminalState.cwd);
  }
  if (terminalState?.shell) {
    contextParts.push(terminalState.shell);
  }
  aiContextEl.textContent = contextParts.join(" · ");
  aiPromptEl.value = aiState.prompt;

  if (aiState.loading) {
    aiMetaEl.textContent = "Thinking...";
    aiResultsEl.innerHTML = '<div class="ai-loading">Generating pane-aware command suggestions…</div>';
    return;
  }

  if (aiState.error) {
    aiMetaEl.textContent = "Enter: ask model. Esc: cancel.";
    aiResultsEl.innerHTML = `<div class="ai-error">${escapeHtml(aiState.error)}</div>`;
    return;
  }

  if (aiState.suggestions.length === 0) {
    aiMetaEl.textContent = "Enter: ask model. Esc: cancel.";
    aiResultsEl.innerHTML =
      '<div class="ai-empty">Describe the task for this pane. The selected result will be inserted into the prompt without running.</div>';
    return;
  }

  aiMetaEl.textContent = "Enter: insert selected command. Arrow keys or j/k: move. Esc: cancel.";
  aiResultsEl.innerHTML = aiState.suggestions
    .map(
      (item, index) => `
        <div class="ai-result${index === aiState.selectedIndex ? " selected" : ""}" data-index="${index}">
          <pre class="ai-command">${escapeHtml(item.command)}</pre>
          <p class="ai-explanation">${escapeHtml(item.explanation)}</p>
        </div>
      `
    )
    .join("");

  aiResultsEl.querySelectorAll(".ai-result").forEach((element) => {
    element.addEventListener("click", () => {
      aiState.selectedIndex = Number(element.dataset.index || 0);
      renderAiOverlay();
    });
    element.addEventListener("dblclick", () => {
      aiState.selectedIndex = Number(element.dataset.index || 0);
      insertSelectedAiCommand();
    });
  });
}

function openAiOverlay() {
  if (!focusedPaneId || editingPaneId) {
    return;
  }

  aiState.open = true;
  aiState.paneId = focusedPaneId;
  aiState.prompt = "";
  aiState.loading = false;
  aiState.error = "";
  aiState.suggestions = [];
  aiState.selectedIndex = 0;
  ensurePrefixState(false);
  renderAiOverlay();
  queueMicrotask(() => {
    aiPromptEl.focus();
  });
}

function closeAiOverlay() {
  aiState.open = false;
  aiState.loading = false;
  aiState.error = "";
  aiState.suggestions = [];
  aiState.selectedIndex = 0;
  renderAiOverlay();
  focusPaneTerminal(focusedPaneId);
}

async function submitAiPrompt() {
  const prompt = aiPromptEl.value.trim();
  if (!prompt || !aiState.paneId || aiState.loading) {
    return;
  }

  aiState.prompt = prompt;
  aiState.loading = true;
  aiState.error = "";
  aiState.suggestions = [];
  aiState.selectedIndex = 0;
  renderAiOverlay();

  try {
    const result = await window.tmuxApi.suggestCommands({
      paneId: aiState.paneId,
      paneName: getPaneLabel(aiState.paneId),
      prompt,
      recentOutput: getPaneRecentOutput(aiState.paneId)
    });
    const state = terminalRegistry.get(aiState.paneId);
    if (state) {
      state.cwd = result.pane?.cwd || state.cwd;
      state.shell = result.pane?.shell || state.shell;
    }
    aiState.loading = false;
    aiState.suggestions = result.suggestions;
    aiState.selectedIndex = 0;
    renderAiOverlay();
  } catch (error) {
    aiState.loading = false;
    aiState.error = error.message;
    renderAiOverlay();
  }
}

function insertSelectedAiCommand() {
  const suggestion = aiState.suggestions[aiState.selectedIndex];
  if (!suggestion || !aiState.paneId) {
    return;
  }

  window.tmuxApi.writePane({
    paneId: aiState.paneId,
    data: suggestion.command
  });
  closeAiOverlay();
}

function moveAiSelection(delta) {
  if (aiState.suggestions.length === 0) {
    return;
  }

  aiState.selectedIndex = (aiState.selectedIndex + delta + aiState.suggestions.length) % aiState.suggestions.length;
  renderAiOverlay();
}

function renderStatus() {
  const session = getActiveSession();
  if (!session) {
    statusLeftEl.textContent = "";
    return;
  }

  const paneCount = session.paneOrder.length;
  statusLeftEl.innerHTML = `
    <span class="${prefixActive ? "prefix-active" : ""}">${prefixActive ? "prefix ready" : "live input"}</span>
    <span>session ${session.name}</span>
    <span>${paneCount} pane${paneCount === 1 ? "" : "s"}</span>
  `;
}

function renderChrome() {
  sessionsEl.innerHTML = "";

  for (const session of sessions.values()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-tab${session.id === activeSessionId ? " active" : ""}`;
    button.textContent = session.name;
    button.title = "Switch session";
    button.addEventListener("click", () => {
      activeSessionId = session.id;
      if (!session.paneOrder.includes(focusedPaneId)) {
        focusedPaneId = session.paneOrder[0];
      }
      renderChrome();
      renderSessions();
      focusPaneTerminal(focusedPaneId);
    });
    sessionsEl.appendChild(button);
  }

  renderStatus();
}

function renderSessions() {
  workspaceEl.innerHTML = "";

  for (const session of sessions.values()) {
    const view = document.createElement("section");
    view.className = `session-view${session.id === activeSessionId ? " active" : ""}`;
    view.dataset.sessionId = session.id;
    view.appendChild(renderNode(session.root, session.id));
    workspaceEl.appendChild(view);
  }

  fitAllVisibleTerminals();
  renderStatus();
  focusPaneTerminal(focusedPaneId);
}

function renderNode(node, sessionId) {
  if (node.type === "leaf") {
    return renderPane(node.paneId, sessionId);
  }

  const wrapper = document.createElement("div");
  wrapper.className = `split-node ${node.axis}`;

  const first = document.createElement("div");
  first.className = "split-child";
  first.style.flexBasis = `${node.ratio * 100}%`;
  first.style.flexGrow = String(node.ratio);
  first.style.flexShrink = "1";
  first.appendChild(renderNode(node.first, sessionId));

  const second = document.createElement("div");
  second.className = "split-child";
  second.style.flexBasis = `${(1 - node.ratio) * 100}%`;
  second.style.flexGrow = String(1 - node.ratio);
  second.style.flexShrink = "1";
  second.appendChild(renderNode(node.second, sessionId));

  const splitter = document.createElement("div");
  splitter.className = "splitter";
  splitter.addEventListener("pointerdown", (event) => beginDragResize(event, node, wrapper));

  wrapper.append(first, splitter, second);
  return wrapper;
}

function renderPane(paneId, sessionId) {
  const paneEl = document.createElement("div");
  const terminalState = terminalRegistry.get(paneId);
  const session = sessions.get(sessionId);
  const paneName = session?.paneNames?.[paneId] || paneId;
  paneEl.className = `pane${paneId === focusedPaneId ? " focused" : ""}${terminalState?.exited ? " exited" : ""}`;
  paneEl.dataset.paneId = paneId;

  const header = document.createElement("div");
  header.className = "pane-header";
  const titleMarkup =
    editingPaneId === paneId
      ? `<input class="pane-name-input" type="text" value="${escapeAttribute(paneName)}" data-role="pane-name-input" aria-label="Pane name" />`
      : `<span class="pane-id" data-role="pane-name" title="Rename pane">${escapeHtml(paneName)}</span>`;

  header.innerHTML = `
    <div class="pane-title">
      <span class="pane-dot"></span>
      ${titleMarkup}
    </div>
    <div class="pane-actions">
      <button class="pane-button" type="button" data-action="ask-ai" title="Ask AI (Ctrl-a)">AI</button>
      <button class="pane-button" type="button" data-action="split-vertical" title="Split vertical (Ctrl-b |)">|</button>
      <button class="pane-button" type="button" data-action="split-horizontal" title="Split horizontal (Ctrl-b -)">-</button>
      <button class="pane-button" type="button" data-action="close" title="Close pane (Ctrl-b x)">x</button>
    </div>
  `;

  const titleEl = header.querySelector('[data-role="pane-name"]');
  titleEl?.addEventListener("click", (event) => {
    event.stopPropagation();
    focusedPaneId = paneId;
    editingPaneId = paneId;
    renderSessions();
  });

  const inputEl = header.querySelector('[data-role="pane-name-input"]');
  if (inputEl) {
    inputEl.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    inputEl.addEventListener("blur", () => {
      commitPaneName(sessionId, paneId, inputEl.value);
    });
    inputEl.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        commitPaneName(sessionId, paneId, inputEl.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        editingPaneId = null;
        renderSessions();
        focusPaneTerminal(paneId);
      }
    });
    queueMicrotask(() => {
      inputEl.focus();
      inputEl.select();
    });
  }

  header.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) {
      return;
    }

    event.stopPropagation();
    focusedPaneId = paneId;
    if (button.dataset.action === "ask-ai") {
      openAiOverlay();
    } else if (button.dataset.action === "split-vertical") {
      splitFocusedPane("row");
    } else if (button.dataset.action === "split-horizontal") {
      splitFocusedPane("column");
    } else if (button.dataset.action === "close") {
      closeFocusedPane();
    }
  });

  const host = document.createElement("div");
  host.className = "terminal-host";

  const terminalShell = document.createElement("div");
  terminalShell.className = "terminal-shell";
  host.appendChild(terminalShell);

  const overlay = document.createElement("div");
  overlay.className = "pane-overlay";
  overlay.innerHTML = `
    <div class="overlay-card">
      <h2>Process exited</h2>
      <p>This pane is no longer attached to a running shell. Split another pane or close this one.</p>
      <button class="chrome-button" type="button">Close Pane</button>
    </div>
  `;
  overlay.querySelector("button").addEventListener("click", () => {
    focusedPaneId = paneId;
    closeFocusedPane();
  });

  paneEl.append(header, host, overlay);

  queueMicrotask(() => {
    mountTerminal(paneId, terminalShell, sessionId);
  });

  return paneEl;
}

async function ensurePaneTerminal(paneId) {
  if (terminalRegistry.has(paneId)) {
    return terminalRegistry.get(paneId);
  }

  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: '"Iosevka Term", "SF Mono", monospace',
    fontSize: 14,
    theme: {
      background: "#111417",
      foreground: "#dce3ec",
      cursor: "#7dd3a0",
      selectionBackground: "rgba(136, 192, 255, 0.28)"
    },
    scrollback: 5000
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  terminal.attachCustomKeyEventHandler((event) => {
    if (aiState.open) {
      return false;
    }

    const key = normalizeKey(event);

    if (event.type !== "keydown") {
      return true;
    }

    if (event.ctrlKey && !event.metaKey && !event.altKey && key === "a") {
      openAiOverlay();
      return false;
    }

    if (event.ctrlKey && !event.metaKey && !event.altKey && key === "b") {
      ensurePrefixState(true);
      return false;
    }

    if (!prefixActive) {
      return true;
    }

    if (consumePrefixCommand(key, event)) {
      return false;
    }

    ensurePrefixState(false);
    return false;
  });

  terminal.onData((data) => {
    window.tmuxApi.writePane({ paneId, data });
  });

  terminalRegistry.set(paneId, {
    paneId,
    terminal,
    fitAddon,
    resizeObserver: null,
    mountedElement: null,
    exited: false,
    shell: null,
    cwd: null,
    recentOutput: ""
  });

  const result = await window.tmuxApi.createPane({ paneId });
  if (result) {
    const state = terminalRegistry.get(paneId);
    if (state) {
      state.shell = result.shell || state.shell;
      state.cwd = result.cwd || state.cwd;
    }
  }
  return terminalRegistry.get(paneId);
}

function mountTerminal(paneId, mountPoint, sessionId) {
  const state = terminalRegistry.get(paneId);
  if (!state) {
    return;
  }

  if (state.mountedElement === mountPoint) {
    attachResizeObserver(state, mountPoint);
    return;
  }

  if (!state.terminal.element) {
    state.terminal.open(mountPoint);
  } else if (state.terminal.element.parentElement !== mountPoint) {
    mountPoint.appendChild(state.terminal.element);
  }

  state.mountedElement = mountPoint;
  attachResizeObserver(state, mountPoint);

  if (activeSessionId === sessionId && paneId === focusedPaneId) {
    focusPaneTerminal(paneId);
    fitTerminal(state);
  }
}

function attachResizeObserver(state, mountPoint) {
  state.resizeObserver?.disconnect();
  state.resizeObserver = new ResizeObserver(() => fitTerminal(state));
  state.resizeObserver.observe(mountPoint);
  fitTerminal(state);
}

function fitTerminal(state) {
  if (!state?.mountedElement || !state.terminal.element || !state.mountedElement.offsetParent) {
    return;
  }

  state.fitAddon.fit();
  const { cols, rows } = state.terminal;
  window.tmuxApi.resizePane({ paneId: state.paneId, cols, rows });
}

function fitAllVisibleTerminals() {
  for (const paneId of getActiveSession()?.paneOrder || []) {
    const state = terminalRegistry.get(paneId);
    if (state) {
      fitTerminal(state);
    }
  }
}

function findLeafPath(node, paneId, path = []) {
  if (node.type === "leaf") {
    return node.paneId === paneId ? path : null;
  }

  return (
    findLeafPath(node.first, paneId, [...path, { node, branch: "first" }]) ||
    findLeafPath(node.second, paneId, [...path, { node, branch: "second" }])
  );
}

function replaceNodeByPath(root, path, replacement) {
  if (path.length === 0) {
    return replacement;
  }

  const [{ node, branch }, ...rest] = path;
  if (root !== node) {
    throw new Error("Path mismatch while replacing node");
  }

  return {
    ...root,
    [branch]: replaceNodeByPath(root[branch], rest, replacement)
  };
}

function removeLeaf(root, paneId) {
  if (root.type === "leaf") {
    return root.paneId === paneId ? null : root;
  }

  const first = removeLeaf(root.first, paneId);
  const second = removeLeaf(root.second, paneId);

  if (!first && !second) {
    return null;
  }

  if (!first) {
    return second;
  }

  if (!second) {
    return first;
  }

  return {
    ...root,
    first,
    second
  };
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function getDefaultPaneName(session) {
  return `pane ${session.paneOrder.length + 1}`;
}

function commitPaneName(sessionId, paneId, rawValue) {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }

  const nextName = rawValue.trim() || session.paneNames[paneId] || paneId;
  session.paneNames[paneId] = nextName;
  editingPaneId = null;
  renderSessions();
  focusPaneTerminal(paneId);
}

function findSessionContainingPane(paneId) {
  for (const session of sessions.values()) {
    if (session.paneOrder.includes(paneId)) {
      return session;
    }
  }

  return null;
}

function removeSession(sessionId) {
  sessions.delete(sessionId);

  if (sessions.size === 0) {
    activeSessionId = null;
    focusedPaneId = null;
    createSession("main");
    return;
  }

  if (activeSessionId === sessionId) {
    const [nextSession] = sessions.values();
    activeSessionId = nextSession.id;
    focusedPaneId = nextSession.paneOrder[0] || null;
  }
}

function removePaneById(paneId, { killProcess = true } = {}) {
  const session = findSessionContainingPane(paneId);
  if (!session) {
    return;
  }

  session.root = removeLeaf(session.root, paneId);
  session.paneOrder = session.paneOrder.filter((id) => id !== paneId);
  delete session.paneNames[paneId];
  if (editingPaneId === paneId) {
    editingPaneId = null;
  }
  if (aiState.paneId === paneId) {
    aiState.open = false;
    aiState.paneId = null;
    aiState.prompt = "";
    aiState.loading = false;
    aiState.error = "";
    aiState.suggestions = [];
    aiState.selectedIndex = 0;
    renderAiOverlay();
  }

  const state = terminalRegistry.get(paneId);
  state?.resizeObserver?.disconnect();
  terminalRegistry.delete(paneId);

  if (killProcess) {
    window.tmuxApi.killPane(paneId);
  }

  if (session.paneOrder.length === 0) {
    removeSession(session.id);
    renderChrome();
    renderSessions();
    focusPaneTerminal(focusedPaneId);
    return;
  }

  if (focusedPaneId === paneId || !session.paneOrder.includes(focusedPaneId)) {
    focusedPaneId = session.paneOrder[0];
  }

  renderChrome();
  renderSessions();
  focusPaneTerminal(focusedPaneId);
}

function splitFocusedPane(axis) {
  const session = getActiveSession();
  if (!session || !focusedPaneId) {
    return;
  }

  const path = findLeafPath(session.root, focusedPaneId);
  if (!path) {
    return;
  }

  const newPaneId = nextId("pane");
  const replacement = createSplit(axis, createLeaf(focusedPaneId), createLeaf(newPaneId));
  session.root = replaceNodeByPath(session.root, path, replacement);
  session.paneNames[newPaneId] = getDefaultPaneName(session);
  session.paneOrder.push(newPaneId);
  focusedPaneId = newPaneId;
  ensurePaneTerminal(newPaneId).then(() => {
    renderChrome();
    renderSessions();
    focusPaneTerminal(newPaneId);
  });
}

function closeFocusedPane() {
  const session = getActiveSession();
  if (!session || !focusedPaneId) {
    return;
  }

  removePaneById(focusedPaneId);
}

function focusInDirection(direction) {
  const session = getActiveSession();
  if (!session || !focusedPaneId) {
    return;
  }

  const leaves = [];
  collectLeaves(session.root, leaves);
  const current = leaves.find((item) => item.paneId === focusedPaneId);
  if (!current) {
    return;
  }

  const candidates = leaves.filter((item) => {
    if (direction === "left") {
      return item.centerX < current.centerX - 4;
    }
    if (direction === "right") {
      return item.centerX > current.centerX + 4;
    }
    if (direction === "up") {
      return item.centerY < current.centerY - 4;
    }
    return item.centerY > current.centerY + 4;
  });

  if (candidates.length === 0) {
    return;
  }

  candidates.sort((a, b) => {
    const primaryA = direction === "left" || direction === "right" ? Math.abs(a.centerX - current.centerX) : Math.abs(a.centerY - current.centerY);
    const primaryB = direction === "left" || direction === "right" ? Math.abs(b.centerX - current.centerX) : Math.abs(b.centerY - current.centerY);
    const secondaryA = direction === "left" || direction === "right" ? Math.abs(a.centerY - current.centerY) : Math.abs(a.centerX - current.centerX);
    const secondaryB = direction === "left" || direction === "right" ? Math.abs(b.centerY - current.centerY) : Math.abs(b.centerX - current.centerX);
    return primaryA - primaryB || secondaryA - secondaryB;
  });

  focusedPaneId = candidates[0].paneId;
  renderSessions();
}

function collectLeaves(node, leaves) {
  if (node.type === "leaf") {
    const element = document.querySelector(`.pane[data-pane-id="${node.paneId}"]`);
    if (!element) {
      return;
    }
    const rect = element.getBoundingClientRect();
    leaves.push({
      paneId: node.paneId,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2
    });
    return;
  }

  collectLeaves(node.first, leaves);
  collectLeaves(node.second, leaves);
}

function resizeFocusedPane(direction) {
  const session = getActiveSession();
  if (!session || !focusedPaneId) {
    return;
  }

  const path = findLeafPath(session.root, focusedPaneId);
  if (!path) {
    return;
  }

  const axis = direction === "left" || direction === "right" ? "row" : "column";
  const desiredBranch = direction === "left" || direction === "up" ? "first" : "second";

  for (let index = path.length - 1; index >= 0; index -= 1) {
    const segment = path[index];
    if (segment.node.axis !== axis) {
      continue;
    }

    const delta = segment.branch === desiredBranch ? RESIZE_STEP : -RESIZE_STEP;
    segment.node.ratio = clampRatio(segment.node.ratio + delta);
    renderSessions();
    return;
  }
}

function clampRatio(value) {
  return Math.max(MIN_RATIO, Math.min(1 - MIN_RATIO, value));
}

function beginDragResize(event, node, splitElement) {
  event.preventDefault();
  splitElement.querySelector(".splitter")?.classList.add("dragging");

  const rect = splitElement.getBoundingClientRect();
  const startPosition = node.axis === "row" ? event.clientX : event.clientY;
  const total = node.axis === "row" ? rect.width - 10 : rect.height - 10;
  const startRatio = node.ratio;

  const onMove = (moveEvent) => {
    const nextPosition = node.axis === "row" ? moveEvent.clientX : moveEvent.clientY;
    const delta = nextPosition - startPosition;
    const nextRatio = clampRatio(startRatio + delta / total);
    node.ratio = nextRatio;
    renderSessions();
  };

  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    splitElement.querySelector(".splitter")?.classList.remove("dragging");
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function cycleSession(direction) {
  const sessionList = [...sessions.values()];
  if (sessionList.length < 2) {
    return;
  }

  const currentIndex = sessionList.findIndex((session) => session.id === activeSessionId);
  const nextIndex = (currentIndex + direction + sessionList.length) % sessionList.length;
  activeSessionId = sessionList[nextIndex].id;
  focusedPaneId = getActiveSession().paneOrder[0];
  renderChrome();
  renderSessions();
  focusPaneTerminal(focusedPaneId);
}

function handlePrefixCommand(key, event = null) {
  const isVerticalSplit =
    key === "|" || (event?.code === "Backslash" && event.shiftKey) || key === "\\";

  if (isVerticalSplit) {
    splitFocusedPane("row");
    return true;
  }
  if (key === "-") {
    splitFocusedPane("column");
    return true;
  }
  if (key === "x") {
    closeFocusedPane();
    return true;
  }
  if (key === "c") {
    createSession();
    return true;
  }
  if (key === "n") {
    cycleSession(1);
    return true;
  }
  if (key === "p") {
    cycleSession(-1);
    return true;
  }

  const focusMap = {
    h: "left",
    j: "down",
    k: "up",
    l: "right"
  };
  if (focusMap[key]) {
    focusInDirection(focusMap[key]);
    return true;
  }

  const resizeMap = {
    H: "left",
    J: "down",
    K: "up",
    L: "right"
  };
  if (resizeMap[key]) {
    resizeFocusedPane(resizeMap[key]);
    return true;
  }

  return false;
}

document.addEventListener("keydown", (event) => {
  if (aiState.open) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeAiOverlay();
      return;
    }

    if (event.target === aiPromptEl) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submitAiPrompt();
      }
      return;
    }

    if (event.key === "ArrowDown" || event.key === "j") {
      event.preventDefault();
      moveAiSelection(1);
      return;
    }

    if (event.key === "ArrowUp" || event.key === "k") {
      event.preventDefault();
      moveAiSelection(-1);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      insertSelectedAiCommand();
      return;
    }

    return;
  }

  const key = normalizeKey(event);

  if (event.ctrlKey && !event.metaKey && !event.altKey && key === "a") {
    event.preventDefault();
    openAiOverlay();
    return;
  }

  if (event.ctrlKey && !event.metaKey && !event.altKey && key === "b") {
    event.preventDefault();
    ensurePrefixState(true);
    return;
  }

  if (!prefixActive) {
    return;
  }

  const handled = consumePrefixCommand(key, event);
  if (handled) {
    event.preventDefault();
    return;
  }

  event.preventDefault();
  ensurePrefixState(false);
});

newSessionButton.addEventListener("click", () => {
  createSession();
});

aiPromptEl.addEventListener("keydown", (event) => {
  if (!aiState.open) {
    return;
  }

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (aiState.suggestions.length > 0 && !aiState.loading) {
      insertSelectedAiCommand();
    } else {
      submitAiPrompt();
    }
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    closeAiOverlay();
    return;
  }

  if (event.key === "ArrowDown" || event.key === "j") {
    if (aiState.suggestions.length > 0) {
      event.preventDefault();
      moveAiSelection(1);
    }
    return;
  }

  if (event.key === "ArrowUp" || event.key === "k") {
    if (aiState.suggestions.length > 0) {
      event.preventDefault();
      moveAiSelection(-1);
    }
  }
});

window.tmuxApi.onData(({ paneId, data }) => {
  const state = terminalRegistry.get(paneId);
  if (!state) {
    return;
  }

  state.terminal.write(data);
  state.recentOutput = `${state.recentOutput}${data}`.slice(-MAX_CONTEXT_CHARS);
});

window.tmuxApi.onExit(({ paneId }) => {
  removePaneById(paneId, { killProcess: false });
});

workspaceEl.addEventListener("mousedown", (event) => {
  if (aiState.open) {
    return;
  }

  const paneEl = event.target.closest(".pane");
  if (!paneEl) {
    return;
  }

  const paneId = paneEl.dataset.paneId;
  if (!paneId) {
    return;
  }

  const alreadyFocused = paneId === focusedPaneId;
  focusedPaneId = paneId;
  if (!alreadyFocused) {
    renderSessions();
  }
  focusPaneTerminal(paneId);
});

window.addEventListener("resize", () => {
  fitAllVisibleTerminals();
});

renderAiOverlay();
createSession("main");
