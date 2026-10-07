const $ = (id) => document.getElementById(id);
const token = () => sessionStorage.getItem("nebula.commandToken") || "";
let taskPlan = null;
let taskId = null;
let taskPoll = null;

let researchResults = [];
function toast(message) {
  $("toast").textContent = message;
  $("toast").style.display = "block";
  setTimeout(() => $("toast").style.display = "none", 4500);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", "x-command-token": token(), ...(options.headers || {}) }
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.message || value.error || "Request failed");
  return value;
}

function navigate(id) {
  if (!$("sidebar")) return;

  if (!$(id)) id = "overview";

  document.querySelectorAll(".page").forEach((node) => node.classList.toggle("active", node.id === id));
  document.querySelectorAll("nav a").forEach((node) => node.classList.toggle("active", node.dataset.page === id));

  const expectedPath = `/command/${id}`;
  if (location.pathname !== expectedPath && location.hash !== `#${id}`) {
    history.pushState({ page: id }, "", expectedPath);
  }

  if (id === "studio") loadProjects();
  if (id === "jarvis") loadProjects();
  if (id === "research") loadProjects();
  if (id === "jobs") loadAudit();

  const sidebar = $("sidebar");
  if (sidebar.classList.contains("open")) {
    sidebar.classList.remove("open");
    $("sidebar-overlay").classList.remove("open");
    $("nav-toggle").setAttribute("aria-expanded", "false");
  }
}

function initRoute() {
  const pathMatch = location.pathname.match(/\/command\/([a-z-]+)/);
  let page = pathMatch ? pathMatch[1] : location.hash.slice(1);
  const legacyMap = { workspace: "studio", audit: "jobs" };
  page = legacyMap[page] || page || "overview";
  navigate(page);
}

window.addEventListener("popstate", (e) => {
  if (e.state && e.state.page) {
    navigate(e.state.page);
  } else {
    initRoute();
  }
});

document.querySelectorAll("nav a").forEach((node) => {
  node.addEventListener("click", (e) => {
    e.preventDefault();
    navigate(node.dataset.page);
  });
});

$("nav-toggle").addEventListener("click", () => {
  const sidebar = $("sidebar");
  const isOpen = sidebar.classList.contains("open");
  sidebar.classList.toggle("open");
  $("sidebar-overlay").classList.toggle("open");
  $("nav-toggle").setAttribute("aria-expanded", !isOpen);
});

$("sidebar-overlay").addEventListener("click", () => {
  $("sidebar").classList.remove("open");
  $("sidebar-overlay").classList.remove("open");
  $("nav-toggle").setAttribute("aria-expanded", "false");
});

async function loadStatus() {
  try {
    const result = await api("/api/status", { method: "POST", body: "{}" });
    $("overall").textContent = result.state.toUpperCase();
    $("overall").className = `badge ${result.state}`;
    $("services").replaceChildren(...Object.entries(result.services).map(([name, service]) => {
      const card = document.createElement("div");
      card.className = "card";
      const title = document.createElement("strong");
      title.className = service.state;
      title.textContent = `${service.state} · ${name}`;
      const detail = document.createElement("p");
      detail.textContent = service.detail || (result.localOnly ? "Local-only policy active" : "Configured");
      card.append(title, detail);
      return card;
    }));
  } catch (error) {
    $("overall").textContent = "UNAUTHORIZED / OFFLINE";
    $("overall").className = "badge offline";
    toast(error.message);
  }
}

function renderMessages() {
  const messages = JSON.parse(sessionStorage.getItem("nebula.commandChat") || "[]");
  $("messages").replaceChildren();
  if (!messages.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Ask Jarvis to inspect the local platform or help plan a task.";
    $("messages").append(empty);
  }
  messages.forEach((message) => {
    const node = document.createElement("div");
    node.className = `message ${message.role}`;
    const content = document.createElement("div");
    content.textContent = message.content;
    node.append(content);
    if (message.role === "assistant" && (message.project || message.memories?.length)) {
      node.append(renderMemoryReferences(message.project, message.memories || []));
    }
    $("messages").append(node);
  });
  const msgs = $("messages");
  msgs.scrollTop = msgs.scrollHeight;
}

function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function memoryTimestamp(memory) {
  return memory.capturedAt || memory.createdAt || null;
}

function renderMemoryReferences(project, memories) {
  const references = document.createElement("section");
  references.className = "memory-references";
  references.setAttribute("aria-label", "Project memories used");
  const heading = document.createElement("strong");
  heading.textContent = project
    ? `Project memory · ${project}`
    : "Project memory";
  references.append(heading);
  if (!memories.length) {
    const empty = document.createElement("span");
    empty.className = "memory-reference-meta";
    empty.textContent = "No saved memories matched this answer.";
    references.append(empty);
    return references;
  }
  const list = document.createElement("ul");
  memories.forEach((memory) => {
    const item = document.createElement("li");
    const title = document.createElement("span");
    title.className = "memory-reference-title";
    title.textContent = memory.title || "Untitled memory";
    item.append(title);
    const timestamp = memoryTimestamp(memory);
    if (timestamp) {
      const time = document.createElement("time");
      time.className = "memory-reference-meta";
      time.dateTime = timestamp;
      time.textContent = timestamp;
      item.append(time);
    }
    const sourceUrl = safeHttpUrl(memory.sourceUrl);
    if (sourceUrl) {
      const link = document.createElement("a");
      link.href = sourceUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open source";
      item.append(link);
    }
    list.append(item);
  });
  references.append(list);
  return references;
}

$("jarvis-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  const history = JSON.parse(sessionStorage.getItem("nebula.commandChat") || "[]");
  const message = $("message").value.trim();
  history.push({ role: "user", content: message });
  sessionStorage.setItem("nebula.commandChat", JSON.stringify(history.slice(-30)));
  renderMessages();
  try {
    const result = await api("/api/jarvis/chat", { method: "POST", body: JSON.stringify({ message, projectSlug: $("jarvis-project").value || undefined }) });
    history.push({ ...result.message, project: result.project, memories: result.memories || [] });
    sessionStorage.setItem("nebula.commandChat", JSON.stringify(history.slice(-30)));
    $("message").value = "";
    renderMessages();
  } catch (error) { toast(`Jarvis unavailable: ${error.message}`); } finally { button.disabled = false; }
});

async function loadProjects() {
  try {
    const result = await api("/api/command/projects");
    [["task-project", "Select a project"], ["jarvis-project", "No project selected"], ["research-project", "Select a project"]].forEach(([id, placeholder]) => {
      const select = $(id);
      if (!select) return;
      const selected = select.value;
      select.replaceChildren(new Option(placeholder, ""), ...result.projects.map((project) => new Option(`${project.name} · ${project.slug}`, project.slug)));
      if (result.projects.some((project) => project.slug === selected)) select.value = selected;
    });
    $("projects").replaceChildren(...result.projects.map((project) => {
      const button = document.createElement("button");
      button.className = "list-item";
      button.textContent = `${project.name} · ${project.slug}`;
      button.addEventListener("click", () => loadFiles(project.slug));
      return button;
    }));
  } catch (error) { toast(error.message); }
}

function renderTaskPlan() {
  const target = $("task-plan");
  target.replaceChildren();
  if (!taskPlan) return;
  const title = document.createElement("strong");
  title.textContent = `Plan · ${taskPlan.steps.length} bounded steps · ${taskPlan.model}`;
  target.append(title);
  taskPlan.steps.forEach((step, index) => {
    const item = document.createElement("div");
    item.className = "task-step";
    const heading = document.createElement("strong");
    heading.textContent = `${index + 1}. ${step.kind}`;
    const detail = document.createElement("code");
    detail.textContent = step.kind === "write"
      ? `Write ${step.path} (${step.content.length} characters)`
      : step.kind === "command"
      ? `${step.program} ${step.args.join(" ")}${step.cwd ? ` · cwd ${step.cwd}` : ""}`
      : `Read ${step.path}`;
    item.append(heading, detail);
    target.append(item);
  });
  const actions = document.createElement("div");
  actions.className = "task-actions";
  const start = document.createElement("button");
  start.type = "button";
  start.className = "primary";
  start.textContent = "Start this plan";
  start.addEventListener("click", startTask);
  actions.append(start);
  target.append(actions);
}

function renderTaskJob(job) {
  const target = $("task-job");
  target.replaceChildren();
  if (!job) return;
  const status = document.createElement("strong");
  status.textContent = `Task ${job.status} · step ${Math.min(job.currentStep + 1, job.plan.length)} of ${job.plan.length}`;
  target.append(status);
  if (job.approval) {
    const notice = document.createElement("p");
    notice.textContent = `Approval required: ${job.approval.summary}`;
    const actions = document.createElement("div");
    actions.className = "task-actions";
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "primary";
    approve.textContent = "Approve and continue";
    approve.addEventListener("click", () => approveTask(true));
    const deny = document.createElement("button");
    deny.type = "button";
    deny.className = "danger";
    deny.textContent = "Decline and stop";
    deny.addEventListener("click", () => approveTask(false));
    actions.append(approve, deny);
    target.append(notice, actions);
  }
  if (job.error) {
    const error = document.createElement("p");
    error.className = "offline";
    error.textContent = job.error;
    target.append(error);
  }
  for (const observation of job.observations || []) {
    const item = document.createElement("div");
    item.className = "task-observation";
    const heading = document.createElement("strong");
    heading.textContent = `Step ${observation.step + 1} · ${observation.outcome}`;
    const output = document.createElement("pre");
    output.textContent = observation.output || "(no output)";
    item.append(heading, output);
    target.append(item);
  }
  if (["complete", "failed", "cancelled"].includes(job.status)) {
    if (taskPoll) clearInterval(taskPoll);
    taskPoll = null;
  } else if (!taskPoll) {
    taskPoll = setInterval(refreshTask, 1000);
  }
}

async function planTask(event) {
  event.preventDefault();
  const project = $("task-project").value;
  const goal = $("task-goal").value.trim();
  const paths = $("task-paths").value.split(",").map((path) => path.trim()).filter(Boolean);
  if (!project) return toast("Select a project before planning a task");
  const button = event.submitter;
  button.disabled = true;
  try {
    taskPlan = await api(`/api/command/projects/${encodeURIComponent(project)}/tasks/plan`, {
      method: "POST",
      body: JSON.stringify({ goal, paths })
    });
    taskId = null;
    if (taskPoll) clearInterval(taskPoll);
    taskPoll = null;
    $("task-job").replaceChildren();
    renderTaskPlan();
  } catch (error) { toast(`Planning failed: ${error.message}`); } finally { button.disabled = false; }
}

async function startTask() {
  if (!taskPlan) return;
  const project = $("task-project").value;
  try {
    const job = await api(`/api/command/projects/${encodeURIComponent(project)}/tasks`, {
      method: "POST",
      body: JSON.stringify({ goal: taskPlan.goal, plan: taskPlan.steps })
    });
    taskId = job.id;
    renderTaskJob(job);
  } catch (error) { toast(`Task could not start: ${error.message}`); }
}

async function refreshTask() {
  if (!taskId) return;
  try { renderTaskJob(await api(`/api/command/tasks/${encodeURIComponent(taskId)}`)); }
  catch (error) { if (taskPoll) clearInterval(taskPoll); taskPoll = null; toast(error.message); }
}

async function approveTask(approved) {
  if (!taskId) return;
  try {
    renderTaskJob(await api(`/api/command/tasks/${encodeURIComponent(taskId)}/approve`, {
      method: "POST",
      body: JSON.stringify({ approved })
    }));
  } catch (error) { toast(`Approval failed: ${error.message}`); }
}

$("task-form").addEventListener("submit", planTask);

async function loadFiles(project) {
  $("selected-project").textContent = `Project: ${project}`;
  try {
    const result = await api(`/api/command/projects/${encodeURIComponent(project)}/files`);
    $("files").replaceChildren(...result.files.map((path) => {
      const button = document.createElement("button");
      button.className = "list-item";
      button.textContent = path;
      button.addEventListener("click", () => readFile(project, path));
      return button;
    }));
  } catch (error) { toast(error.message); }
}

async function readFile(project, path) {
  try {
    const result = await api(`/api/command/projects/${encodeURIComponent(project)}/files?path=${encodeURIComponent(path)}`);
    $("file-content").textContent = result.content;
  } catch (error) { toast(error.message); }
}

$("project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/command/projects", { method: "POST", body: JSON.stringify({ slug: $("project-slug").value, name: $("project-name").value }) });
    event.target.reset();
    await loadProjects();
    toast("Project created inside the configured workspace root");
  } catch (error) { toast(error.message); }
});

async function loadResearch(event) {
  event?.preventDefault();
  try {
    const project = $("research-project").value;
    const result = await api(`/api/research?q=${encodeURIComponent($("query").value)}${project ? `&project=${encodeURIComponent(project)}` : ""}`);
    researchResults = result.results;
    $("results").replaceChildren(...result.results.map((item, index) => {
      const article = document.createElement("article");
      const link = document.createElement("a");
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = item.title || item.url;
      const text = document.createElement("p");
      text.textContent = item.content || "";
      const save = document.createElement("button");
      save.type = "button";
      save.textContent = project ? "Save to project" : "Select a project to save";
      save.disabled = !project;
      save.addEventListener("click", () => saveResearch(index, save));
      article.append(link, text, save);
      return article;
    }));
  } catch (error) { toast(error.message); }
}

async function saveResearch(index, button) {
  const project = $("research-project").value;
  const item = researchResults[index];
  if (!project || !item) return toast("Select a project before saving research");
  button.disabled = true;
  try {
    await api(`/api/command/projects/${encodeURIComponent(project)}/memories`, {
      method: "POST",
      body: JSON.stringify({ kind: "research", sourceUrl: item.url, title: item.title, content: item.content, capturedAt: item.capturedAt })
    });
    button.textContent = "Saved to project";
  } catch (error) {
    button.disabled = false;
    toast(`Research could not be saved: ${error.message}`);
  }
}
async function loadAudit() {
  try {
    const result = await api("/api/command/audit");
    $("events").replaceChildren(...result.events.map((event) => {
      const row = document.createElement("div");
      row.className = "event";
      const summary = document.createElement("div");
      summary.textContent = `${event.createdAt} · ${event.outcome} · ${event.action}${event.projectSlug ? ` · ${event.projectSlug}` : ""}`;
      row.append(summary);
      if (event.action === "jarvis.chat" && (event.projectSlug || event.detail?.memories?.length)) {
        row.append(renderMemoryReferences(event.projectSlug, event.detail?.memories || []));
      }
      return row;
    }));
  } catch (error) { toast(error.message); }
}

$("save-token").addEventListener("click", () => {
  sessionStorage.setItem("nebula.commandToken", $("token").value);
  toast("Command token stored for this browser session");
  loadStatus();
});
$("refresh").addEventListener("click", loadStatus);
$("refresh-projects").addEventListener("click", loadProjects);
$("refresh-audit").addEventListener("click", loadAudit);
$("token").value = token();
renderMessages();
initRoute();
loadStatus();

async function searchMemory(event) {
  event?.preventDefault();
  const project = $("research-project").value;
  if (!project) return toast("Select a project before searching memory");
  try {
    const result = await api(`/api/command/projects/${encodeURIComponent(project)}/memories?q=${encodeURIComponent($("memory-query").value)}`);
    $("memory-results").replaceChildren(...result.memories.map((item) => {
      const article = document.createElement("article");
      const heading = document.createElement("strong");
      heading.textContent = `${item.kind} · ${item.title || "Untitled"}`;
      const meta = document.createElement("p");
      meta.className = "fine";
      meta.textContent = `${item.capturedAt || item.createdAt}${item.sourceUrl ? ` · ${item.sourceUrl}` : ""}`;
      const content = document.createElement("p");
      content.textContent = item.content;
      article.append(heading, meta, content);
      return article;
    }));
    if (!result.memories.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No matching saved memory in this project.";
      $("memory-results").append(empty);
    }
  } catch (error) { toast(`Memory search failed: ${error.message}`); }
}

async function saveMemoryNote(event) {
  event.preventDefault();
  const project = $("research-project").value;
  if (!project) return toast("Select a project before saving memory");
  try {
    await api(`/api/command/projects/${encodeURIComponent(project)}/memories`, {
      method: "POST",
      body: JSON.stringify({ kind: $("memory-kind").value, title: $("memory-title").value, content: $("memory-content").value })
    });
    $("memory-note-form").reset();
    toast("Memory saved to the selected project");
  } catch (error) { toast(`Memory could not be saved: ${error.message}`); }
}

async function rebuildMemory() {
  const project = $("research-project").value;
  if (!project) return toast("Select a project before rebuilding memory");
  if (!window.confirm(`Rebuild missing local embeddings for project "${project}"?`)) return;
  const button = $("rebuild-memory");
  button.disabled = true;
  $("rebuild-memory-result").textContent = "Rebuilding up to 100 missing embeddings locally…";
  try {
    const result = await api(`/api/command/projects/${encodeURIComponent(project)}/memories/rebuild`, {
      method: "POST",
      body: JSON.stringify({ confirm: true, limit: 100 })
    });
    $("rebuild-memory-result").textContent = `Embedded ${result.processed} memories with ${result.model}. ${result.remaining} still missing. Request ${result.requestId}.`;
    toast("Local memory rebuild completed");
  } catch (error) {
    $("rebuild-memory-result").textContent = `Rebuild failed: ${error.message}`;
    toast(`Memory rebuild failed: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

$("rebuild-memory").addEventListener("click", rebuildMemory);
$("research-form").addEventListener("submit", loadResearch);
$("memory-form").addEventListener("submit", searchMemory);
$("memory-note-form").addEventListener("submit", saveMemoryNote);
