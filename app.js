const DEFAULT_API_URL = "https://bet-analyzer-backend-5g31.onrender.com";
const API_URL = localStorage.getItem("betAnalyzerBackend") || DEFAULT_API_URL;

const $ = (id) => document.getElementById(id);

function todayWarsaw() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function setStatus(text, ok = true) {
  if ($("statusText")) $("statusText").textContent = text;
  if ($("statusDot")) $("statusDot").className = "dot " + (ok ? "ok" : "bad");
}

function saveHistory(data) {
  const history = JSON.parse(localStorage.getItem("betAnalyzerHistory") || "[]");
  history.unshift({
    date: new Date().toISOString(),
    qualifiedEvents: data.qualifiedEvents ?? data.picks?.length ?? 0,
    picks: data.picks || []
  });
  localStorage.setItem("betAnalyzerHistory", JSON.stringify(history.slice(0, 20)));
}

function eventName(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    if (value.home?.name && value.away?.name) return value.home.name + " – " + value.away.name;
    if (value.home_team && value.away_team) return value.home_team + " – " + value.away_team;
    if (value.event && typeof value.event === "string") return value.event;
    if (value.name) return value.name;
  }
  return "Nieznany mecz";
}

function applyFilters(picks) {
  const minProb = Number($("minProb")?.value || 0);
  const limit = Math.max(1, Number($("limit")?.value || 10));
  const market = $("marketType")?.value || "ALL";
  const matches = p => {
    if (market === "ALL") return true;
    const k = String(p.key || "").toUpperCase();
    if (market === "MATCH_ODDS") return ["HOME","DRAW","AWAY","DC1X","DCX2"].includes(k);
    if (market === "OVER_UNDER_25") return ["OVER15","OVER25","UNDER25","UNDER35"].includes(k);
    if (market === "BOTH_TEAMS_TO_SCORE") return ["BTTS_YES","BTTS_NO"].includes(k);
    return true;
  };
  return picks.filter(p => Number(p.probability) >= minProb && matches(p)).slice(0, limit);
}

function renderExchange(data) {
  const box = $("exchangeBox");
  if (!box) return;
  const picks = data?.picks || [];
  box.innerHTML = picks.length ? picks.map((p, i) => {
    const ex = p.exchange || {};
    const mv = p.marketMovement || {};
    return '<article class="card"><strong>#' + (i + 1) + ' ' + escapeHtml(eventName(p.event)) + '</strong>' +
      '<p>' + escapeHtml(p.label || p.key) + ' · kurs ' + escapeHtml(p.odds) + '</p>' +
      '<p>Ruch: <strong>' + escapeHtml(mv.movement || "UNKNOWN") + '</strong></p>' +
      '<p>WOM: <strong>' + escapeHtml(ex.status || "BRAK") + '</strong></p></article>';
  }).join("") : '<div class="note">Brak danych giełdowych do pokazania.</div>';
}

function scheduleRefresh() {
  const seconds = Math.max(5, Number($("refresh")?.value || 15));
  clearInterval(window.betAnalyzerRefresh);
  window.betAnalyzerRefresh = setInterval(() => { if (!document.hidden) scan(); }, seconds * 1000);
}

function renderCards(picks) {
  const box = $("cards");
  if (!box) return;
  if (!picks.length) {
    box.innerHTML = '<div class="note">Brak kwalifikujących się picków dla wybranego dnia.</div>';
    return;
  }
  box.innerHTML = picks.map((p, i) => {
    const ctx = p.context || {};
    const form = ctx.form || {};
    const exchange = p.exchange || {};
    const movement = p.marketMovement || {};
    return `
      <article class="card">
        <div style="display:flex;justify-content:space-between;gap:10px">
          <h3>#${i + 1} ${escapeHtml(eventName(p.event))}</h3>
          <strong>${Number(p.probability).toFixed(1)}%</strong>
        </div>
        <p><strong>${escapeHtml(p.label || p.key)}</strong> · kurs ${escapeHtml(p.odds)}</p>
        <p>Score: <strong>${escapeHtml(p.score)}</strong> · Edge: <strong>${escapeHtml(p.edge)} pp</strong></p>
        <p>Ruch kursu: <strong>${escapeHtml(movement.movement || "UNKNOWN")}</strong></p>
        <p>WOM: <strong>${escapeHtml(exchange.status || "BRAK")}</strong></p>
        <p>Forma: ${escapeHtml((form.home?.form || []).join("-"))} vs ${escapeHtml((form.away?.form || []).join("-"))}</p>
      </article>
    `;
  }).join("");
}

async function scan() {
  const button = $("scan");
  if (button) {
    button.disabled = true;
    button.textContent = "Skanowanie…";
  }
  setStatus("Łączenie z backendem…", true);
  try {
    const date = todayWarsaw();
    const response = await fetch(`${API_URL}/api/scan?date=${date}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data || data.source !== "BSD") throw new Error("Backend zwrócił nieoczekiwany format danych.");
    localStorage.setItem("betAnalyzerLastScan", JSON.stringify(data));
    renderCards(applyFilters(data.picks || []));
    renderExchange(data);
    saveHistory(data);
    setStatus(`LIVE · ${data.qualifiedEvents ?? data.picks?.length ?? 0} kwalifikujących picków · ${date}`, true);
    renderHistory();
  } catch (error) {
    console.error("Błąd skanu:", error);
    setStatus("Błąd połączenia z backendem", false);
    if ($("cards")) $("cards").innerHTML = `<div class="note" style="color:#b91c1c">Nie udało się wykonać skanu: ${escapeHtml(error.message)}</div>`;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Skanuj";
    }
  }
}

async function testConnection() {
  const health = $("health");
  if (health) health.textContent = "Sprawdzam…";
  try {
    const r = await fetch(`${API_URL}/api/health`, { cache: "no-store" });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(`HTTP ${r.status}`);
    if (health) health.textContent = `OK · backend ${d.version || "?"} · BSD ${d.bsdConfigured ? "skonfigurowany" : "brak"}`;
  } catch (e) {
    if (health) health.textContent = `Błąd: ${e.message}`;
  }
}

function renderHistory() {
  const box = $("historyBox");
  if (!box) return;
  const history = JSON.parse(localStorage.getItem("betAnalyzerHistory") || "[]");
  box.innerHTML = history.length
    ? history.map(h => `<div class="card"><strong>${new Date(h.date).toLocaleString("pl-PL")}</strong><br>Picków: ${h.qualifiedEvents}</div>`).join("")
    : '<div class="note">Brak historii skanów.</div>';
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".panel").forEach(p => p.classList.add("hidden"));
      tab.classList.add("active");
      const panel = $(tab.dataset.tab);
      if (panel) panel.classList.remove("hidden");
      if (tab.dataset.tab === "history") renderHistory();
    });
  });
}

function setup() {
  setupTabs();
  if ($("backend")) $("backend").value = API_URL;
  if ($("scan")) $("scan").addEventListener("click", scan);
  if ($("save")) $("save").addEventListener("click", () => {
    const value = ($("backend").value || "").trim().replace(/\/$/, "");
    if (!value) return;
    localStorage.setItem("betAnalyzerBackend", value);
    location.reload();
  });
  if ($("test")) $("test").addEventListener("click", testConnection);
  ["minProb", "limit", "marketType"].forEach(id => {
    if ($(id)) $(id).addEventListener("change", () => {
      const last = JSON.parse(localStorage.getItem("betAnalyzerLastScan") || "null");
      if (last) renderCards(applyFilters(last.picks || []));
    });
  });
  if ($("refresh")) $("refresh").addEventListener("change", scheduleRefresh);
  if ($("mode")) $("mode").textContent = "LIVE";
  scheduleRefresh();
  renderHistory();
}

setup();
