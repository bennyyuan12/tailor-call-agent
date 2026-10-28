let state = null;
let selectedId = null;

const elements = {
  configStatus: document.querySelector("#configStatus"),
  metrics: document.querySelector("#metrics"),
  contactCount: document.querySelector("#contactCount"),
  csvInput: document.querySelector("#csvInput"),
  csvFileInput: document.querySelector("#csvFileInput"),
  approveImport: document.querySelector("#approveImport"),
  resetExistingImport: document.querySelector("#resetExistingImport"),
  callAck: document.querySelector("#callAck"),
  importButton: document.querySelector("#importButton"),
  importTestCsvButton: document.querySelector("#importTestCsvButton"),
  callSelectedButton: document.querySelector("#callSelectedButton"),
  startBatchButton: document.querySelector("#startBatchButton"),
  stopBatchButton: document.querySelector("#stopBatchButton"),
  batchLimit: document.querySelector("#batchLimit"),
  runtimeNotice: document.querySelector("#runtimeNotice"),
  contactsTable: document.querySelector("#contactsTable"),
  refreshButton: document.querySelector("#refreshButton"),
  selectedStatus: document.querySelector("#selectedStatus"),
  emptyDetail: document.querySelector("#emptyDetail"),
  detailContent: document.querySelector("#detailContent"),
  detailName: document.querySelector("#detailName"),
  detailPhone: document.querySelector("#detailPhone"),
  detailCity: document.querySelector("#detailCity"),
  detailState: document.querySelector("#detailState"),
  detailNotes: document.querySelector("#detailNotes"),
  saveContactButton: document.querySelector("#saveContactButton"),
  approveButton: document.querySelector("#approveButton"),
  doNotCallButton: document.querySelector("#doNotCallButton"),
  resetButton: document.querySelector("#resetButton"),
  quotesList: document.querySelector("#quotesList"),
  transcriptList: document.querySelector("#transcriptList"),
  toast: document.querySelector("#toast")
};

elements.csvFileInput.addEventListener("change", async () => {
  const file = elements.csvFileInput.files?.[0];
  if (!file) return;
  elements.csvInput.value = await file.text();
  showToast(`Loaded ${file.name}.`);
});

elements.importButton.addEventListener("click", () => {
  void post("/api/contacts/import", {
    csv: elements.csvInput.value,
    approved: elements.approveImport.checked,
    resetExisting: elements.resetExistingImport.checked
  }).then((result) => {
    showToast(`Imported ${result.imported} contact${result.imported === 1 ? "" : "s"}.`);
    elements.csvInput.value = "";
    void refresh();
  });
});

elements.importTestCsvButton.addEventListener("click", () => {
  void post("/api/contacts/import-test-csv", {}).then((result) => {
    showToast(`Imported ${result.imported} contact${result.imported === 1 ? "" : "s"} from ${result.source}.`);
    void refresh();
  });
});

elements.refreshButton.addEventListener("click", () => {
  void safeRefresh();
});

elements.callSelectedButton.addEventListener("click", () => {
  const contact = selectedContact();
  if (!contact) return showToast("Select a tailor first.");
  void post(`/api/contacts/${contact.id}/call`, {
    acknowledged: elements.callAck.checked
  }).then(() => {
    showToast(`Calling ${contact.name || contact.phone}.`);
    void refresh();
  });
});

elements.startBatchButton.addEventListener("click", () => {
  void post("/api/batch/start", {
    acknowledged: elements.callAck.checked,
    limit: Number(elements.batchLimit.value || 10)
  }).then(() => {
    showToast("Batch started.");
    void refresh();
  });
});

elements.stopBatchButton.addEventListener("click", () => {
  void post("/api/batch/stop", {}).then(() => {
    showToast("Batch stopped.");
    void refresh();
  });
});

elements.saveContactButton.addEventListener("click", () => {
  const contact = selectedContact();
  if (!contact) return;
  void post(`/api/contacts/${contact.id}/update`, {
    name: elements.detailName.value,
    phone: elements.detailPhone.value,
    city: elements.detailCity.value,
    state: elements.detailState.value,
    notes: elements.detailNotes.value
  }).then(() => {
    showToast("Contact saved.");
    void refresh();
  });
});

elements.approveButton.addEventListener("click", () => {
  const contact = selectedContact();
  if (!contact) return;
  void post(`/api/contacts/${contact.id}/update`, {
    approved: !contact.approved
  }).then(() => {
    void refresh();
  });
});

elements.doNotCallButton.addEventListener("click", () => {
  const contact = selectedContact();
  if (!contact) return;
  void post(`/api/contacts/${contact.id}/update`, {
    doNotCall: !contact.doNotCall
  }).then(() => {
    void refresh();
  });
});

elements.resetButton.addEventListener("click", () => {
  const contact = selectedContact();
  if (!contact) return;
  void post(`/api/contacts/${contact.id}/reset`, {}).then(() => {
    void refresh();
  });
});

function connectEvents() {
  const events = new EventSource("/api/events");
  events.onmessage = (event) => {
    state = JSON.parse(event.data);
    render();
  };
  events.onerror = () => {
    elements.runtimeNotice.textContent = "Live updates disconnected. Refreshing by polling.";
    setTimeout(() => void safeRefresh(), 2000);
  };
}

async function refresh() {
  const response = await fetch("/api/state");
  state = await response.json();
  render();
}

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    showToast(payload.error || "Request failed.");
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}

function render() {
  if (!state) return;
  renderConfig();
  renderMetrics();
  renderTable();
  renderDetail();
}

function renderConfig() {
  const config = state.config;
  const chips = [
    pill(config.outboundEnabled ? "Outbound enabled" : "Outbound blocked", config.outboundEnabled ? "good" : "warn"),
    pill(config.hasOpenAIKey ? "OpenAI key" : "No OpenAI key", config.hasOpenAIKey ? "good" : "bad"),
    pill(config.audioProvider === "elevenlabs" ? (config.hasElevenLabsKey ? "ElevenLabs key" : "No ElevenLabs key") : "OpenAI audio", config.audioProvider === "elevenlabs" ? (config.hasElevenLabsKey ? "good" : "bad") : "neutral"),
    pill(config.hasTwilioSid && config.hasTwilioToken && config.hasTwilioFrom ? "Twilio ready" : "Twilio missing", config.hasTwilioSid && config.hasTwilioToken && config.hasTwilioFrom ? "good" : "bad"),
    pill(config.publicBaseUrl || "No public URL", config.publicBaseUrl?.startsWith("https://") ? "good" : "warn"),
    pill(config.model, "neutral"),
    pill(config.voice, "neutral")
  ];
  elements.configStatus.innerHTML = chips.join("");
  elements.runtimeNotice.textContent = config.issues.length ? config.issues.join("; ") : "";
}

function renderMetrics() {
  const stats = state.stats;
  const batchText = state.batch?.running ? `${state.batch.remaining} left` : "Off";
  elements.metrics.innerHTML = [
    metric("Total", stats.total),
    metric("Approved", stats.approved),
    metric("Callable", stats.callable),
    metric("Completed", stats.completed),
    metric("Batch", batchText)
  ].join("");
  elements.contactCount.textContent = String(stats.total);
}

function renderTable() {
  const contacts = state.contacts || [];
  if (!selectedId && contacts[0]) selectedId = contacts[0].id;

  elements.contactsTable.innerHTML = contacts.map((contact) => {
    const location = [contact.city, contact.state].filter(Boolean).join(", ") || "-";
    const status = contact.doNotCall ? "do_not_call" : contact.status;
    return `
      <tr class="${contact.id === selectedId ? "selected" : ""}" data-id="${escapeHtml(contact.id)}">
        <td>
          <div class="shop-name">${escapeHtml(contact.name || "Unnamed shop")}</div>
          <div class="subtle">${contact.approved ? "approved" : "not approved"}${contact.doNotCall ? " / do not call" : ""}</div>
        </td>
        <td>${escapeHtml(contact.phone || "-")}</td>
        <td>${escapeHtml(location)}</td>
        <td><span class="status ${escapeHtml(status || "ready")}">${escapeHtml(labelStatus(status || "ready"))}</span></td>
        <td>${contact.quotes?.length || 0}</td>
        <td>${contact.attempts || 0}</td>
      </tr>
    `;
  }).join("");

  for (const row of elements.contactsTable.querySelectorAll("tr")) {
    row.addEventListener("click", () => {
      selectedId = row.dataset.id;
      render();
    });
  }
}

function renderDetail() {
  const contact = selectedContact();
  if (!contact) {
    elements.emptyDetail.classList.remove("hidden");
    elements.detailContent.classList.add("hidden");
    elements.selectedStatus.textContent = "";
    return;
  }

  elements.emptyDetail.classList.add("hidden");
  elements.detailContent.classList.remove("hidden");
  elements.selectedStatus.innerHTML = `<span class="status ${escapeHtml(contact.status || "ready")}">${escapeHtml(labelStatus(contact.status || "ready"))}</span>`;
  elements.detailName.value = contact.name || "";
  elements.detailPhone.value = contact.phone || "";
  elements.detailCity.value = contact.city || "";
  elements.detailState.value = contact.state || "";
  elements.detailNotes.value = contact.notes || "";
  elements.approveButton.textContent = contact.approved ? "Unapprove" : "Approve";
  elements.doNotCallButton.textContent = contact.doNotCall ? "Clear Do Not Call" : "Mark Do Not Call";

  elements.quotesList.innerHTML = (contact.quotes || []).length
    ? contact.quotes.map(renderQuote).join("")
    : `<div class="subtle">No extracted quotes yet.</div>`;

  elements.transcriptList.innerHTML = (contact.transcript || []).length
    ? contact.transcript.map((turn) => `
      <div class="turn">
        <span>${escapeHtml(turn.speaker)} - ${formatTime(turn.at)}</span>
        <p>${escapeHtml(turn.text)}</p>
      </div>
    `).join("")
    : `<div class="subtle">No transcript yet.</div>`;
}

function renderQuote(quote) {
  const price = quote.priceText || [quote.priceMin, quote.priceMax].filter((item) => item !== null && item !== undefined).map((item) => `$${item}`).join("-");
  const turnaround = quote.turnaroundText || [quote.turnaroundDaysMin, quote.turnaroundDaysMax].filter((item) => item !== null && item !== undefined).join("-");
  return `
    <div class="quote-item">
      <strong>${escapeHtml(quote.service || "Service")}</strong>
      <div>${escapeHtml(price || "Price not captured")}</div>
      <div class="subtle">${escapeHtml(turnaround ? `${turnaround} days` : "Turnaround not captured")}${quote.rushAvailable === true ? " - rush available" : ""}</div>
      <div class="subtle">${escapeHtml(quote.notes || "")}</div>
    </div>
  `;
}

function selectedContact() {
  return state?.contacts?.find((contact) => contact.id === selectedId) || null;
}

function metric(label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
}

function pill(label, kind) {
  return `<span class="pill ${kind === "neutral" ? "" : kind}">${escapeHtml(label)}</span>`;
}

function labelStatus(value) {
  return String(value || "ready").replaceAll("_", " ");
}

function formatTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    elements.toast.classList.add("hidden");
  }, 3600);
}

connectEvents();
void safeRefresh();

async function safeRefresh() {
  try {
    await refresh();
  } catch {
    elements.runtimeNotice.textContent = "Waiting for the local server to reconnect.";
  }
}
