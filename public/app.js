const defaults = { provider: "ollama", model: "llama3.2" };
const settings = () => ({ ...defaults, ...JSON.parse(localStorage.getItem("nebula.settings") || "{}"), apiKey: sessionStorage.getItem("nebula.apiKey") || "" });
const $ = (id) => document.getElementById(id);

function toast(message) {
  $("toast").textContent = message;
  $("toast").style.display = "block";
  setTimeout(() => $("toast").style.display = "none", 4500);
}
async function api(path, payload) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message || "Request failed");
  return value;
}
function navigate(id) {
  document.querySelectorAll(".page").forEach((node) => node.classList.toggle("active", node.id === id));
  document.querySelectorAll("nav button").forEach((node) => node.classList.toggle("active", node.dataset.page === id));
  history.replaceState(null, "", `#${id}`);
}
document.querySelectorAll("nav button").forEach((node) => node.addEventListener("click", () => navigate(node.dataset.page)));

async function refresh() {
  $("overall").textContent = "Checking systems…";
  try {
    const result = await api("/api/status", { settings: settings() });
    $("overall").textContent = result.state.toUpperCase();
    $("overall").className = `badge ${result.state}`;
    $("services").replaceChildren(...Object.entries(result.services).map(([name, service]) => {
      const card = document.createElement("div");
      card.className = "card";
      const title = document.createElement("strong");
      title.className = service.state;
      title.textContent = `${service.state} · ${name}`;
      const detail = document.createElement("p");
      detail.textContent = service.detail || service.endpoint || (service.migrations !== undefined ? `${service.migrations} migrations applied` : "Responding normally");
      card.append(title, detail);
      return card;
    }));
  } catch (error) { $("overall").textContent = "APP OFFLINE"; $("overall").className = "badge offline"; toast(error.message); }
}
$("refresh-status").addEventListener("click", refresh);

function renderMessages() {
  const messages = JSON.parse(localStorage.getItem("nebula.chat") || "[]");
  $("messages").replaceChildren();
  if (!messages.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "Send a message to begin. History stays in this browser and your local database."; $("messages").append(empty); }
  messages.forEach((message) => { const node = document.createElement("div"); node.className = `message ${message.role}`; node.textContent = message.content; $("messages").append(node); });
}
$("chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  const messages = JSON.parse(localStorage.getItem("nebula.chat") || "[]");
  const message = $("message").value.trim();
  messages.push({ role: "user", content: message });
  localStorage.setItem("nebula.chat", JSON.stringify(messages.slice(-40)));
  renderMessages();
  try {
    const result = await api("/api/chat", { ...settings(), message, conversationId: localStorage.getItem("nebula.conversation") });
    messages.push(result.message);
    localStorage.setItem("nebula.chat", JSON.stringify(messages.slice(-40)));
    localStorage.setItem("nebula.conversation", result.conversationId);
    $("message").value = "";
    renderMessages();
  } catch (error) { toast(`Chat unavailable: ${error.message}`); } finally { submit.disabled = false; }
});
$("clear-chat").addEventListener("click", () => { localStorage.removeItem("nebula.chat"); localStorage.removeItem("nebula.conversation"); renderMessages(); });
$("image-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  event.submitter.disabled = true;
  try {
    const result = await api("/api/images", { prompt: $("prompt").value, seed: $("seed").value });
    $("image-result").textContent = `Queued successfully · local job ${result.id}${result.remoteId ? ` · ComfyUI job ${result.remoteId}` : ""}`;
    if (result.remoteId) pollImage(result);
  } catch (error) { $("image-result").textContent = `Image service unavailable · ${error.message}`; } finally { event.submitter.disabled = false; }
});

async function pollImage(job, attempt = 0) {
  if (attempt >= 90) { $("image-result").textContent = "Image is still running. Check ComfyUI for progress."; return; }
  await new Promise((resolve) => setTimeout(resolve, 2000));
  try {
    const result = await api("/api/images/status", { id: job.id, remoteId: job.remoteId });
    if (result.state === "complete") {
      const image = document.createElement("img"); image.src = result.image; image.alt = $("prompt").value; image.style.maxWidth = "100%"; image.style.marginTop = "16px";
      $("image-result").textContent = "Generation complete";
      $("image-result").append(image);
    } else if (result.state === "failed") $("image-result").textContent = result.detail;
    else { $("image-result").textContent = `ComfyUI job ${result.state}…`; pollImage(job, attempt + 1); }
  } catch (error) { $("image-result").textContent = `Could not check image: ${error.message}`; }
}

function loadSettings() {
  const value = settings();
  $("provider").value = value.provider; $("model").value = value.model; $("api-key").value = value.apiKey;
}
$("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  localStorage.setItem("nebula.settings", JSON.stringify({ provider: $("provider").value, model: $("model").value }));
  sessionStorage.setItem("nebula.apiKey", $("api-key").value);
  toast("Settings saved in this browser");
  refresh();
});
$("download-diagnostics").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/diagnostics", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings: settings() }) });
    if (!response.ok) throw new Error("Bundle generation failed");
    const link = document.createElement("a"); link.href = URL.createObjectURL(await response.blob()); link.download = "nebula-diagnostics.json.gz"; link.click(); URL.revokeObjectURL(link.href);
  } catch (error) { toast(error.message); }
});

loadSettings(); renderMessages(); navigate(location.hash.slice(1) || "status"); refresh();