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
    if (market === "OVER_UNDER_25") return ["OVER25","UNDER25"].includes(k);
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
  window.betAnalyzerRefresh = setInterval(() => {
    if (document.hidden) return;
    const active = document.querySelector(".tab.active")?.dataset.tab || "scanner";
    if (active === "scanner") scan("football", "cards", "scan");
    else if (active === "highOdds") scan("football", "highOddsCards", "scanHighOdds");
    else if (active === "basketball") scan("basketball", "basketballCards", "scanBasketball");
    else if (active === "tennis") scan("tennis", "tennisCards", "scanTennis");
  }, seconds * 1000);
}

function renderCards(picks, scanData = {}, boxId = "cards") {
  const box = $(boxId);
  if (!box) return;
  if (!picks.length) {
    if (boxId === "highOddsCards" && Array.isArray(scanData.picks) && scanData.picks.length) {
      const minOdds = Math.max(1.01, Number($("highOddsMin")?.value || 1.80));
      box.innerHTML = '<div class="note"><strong>Brak kwalifikujących picków z kursem co najmniej ' + escapeHtml(minOdds.toFixed(2)) + '.</strong><p>Na dziś skan nie zwrócił typu piłkarskiego spełniającego ten filtr. Nie obniżono kryteriów pozostałych typów.</p></div>';
      return;
    }
    const diagnostics = scanData.diagnostics || {};
    const reasonCounts = diagnostics.reasons && typeof diagnostics.reasons === "object"
      ? Object.entries(diagnostics.reasons).sort((a, b) => Number(b[1]) - Number(a[1]))
      : [];
    const reasonHtml = reasonCounts.length
      ? '<p><strong>Najczęstsze powody odrzucenia:</strong></p><ul>' +
        reasonCounts.slice(0, 8).map(([reason, count]) =>
          '<li>' + escapeHtml(reason) + ': ' + escapeHtml(count) + '</li>'
        ).join("") + '</ul>'
      : '<p>Backend nie zwrócił szczegółowych powodów odrzucenia.</p>';
    const audit = Array.isArray(diagnostics.candidateAudit) ? diagnostics.candidateAudit
      : Array.isArray(scanData.candidateAudit) ? scanData.candidateAudit : [];
    const auditHtml = audit.length
      ? '<p><strong>Najlepsi kandydaci do sprawdzenia (prawdopodobieństwo · kurs · Edge · Score):</strong></p><ul>' +
        audit.slice().sort((a, b) => {
          const aReasons = Array.isArray(a.reasons) ? a.reasons.length : 0;
          const bReasons = Array.isArray(b.reasons) ? b.reasons.length : 0;
          const aEdge = Number.isFinite(Number(a.edge)) ? Number(a.edge) : -999;
          const bEdge = Number.isFinite(Number(b.edge)) ? Number(b.edge) : -999;
          return aReasons - bReasons ||
            bEdge - aEdge ||
            (Number(b.probability) || 0) - (Number(a.probability) || 0);
        }).slice(0, 5).map(item => {
          const name = eventName(item.event || item.match || item.teams || item);
          const market = item.label || item.key || "typ";
          const probability = Number.isFinite(Number(item.probability)) ? Number(item.probability).toFixed(1) + "%" : "brak %";
          const odds = Number.isFinite(Number(item.odds)) ? Number(item.odds).toFixed(2) : "brak kursu";
          const edge = Number.isFinite(Number(item.edge)) ? Number(item.edge).toFixed(2) + " pp" : "brak Edge";
          const score = Number.isFinite(Number(item.score)) ? Number(item.score).toFixed(0) : "brak";
          const reasons = Array.isArray(item.reasons) && item.reasons.length ? item.reasons.join(", ") : "spełnia podstawowe kryteria";
          const warnings = Array.isArray(item.warnings) && item.warnings.includes("NEGATIVE_EDGE_WARNING")
            ? '<br><strong>Ostrzeżenie:</strong> ujemny Edge — nie blokuje typu, ale oznacza brak przewagi względem kursu.'
            : "";
          return '<li><strong>' + escapeHtml(name) + '</strong> — ' + escapeHtml(market) +
            '<br>Prawdopodobieństwo: ' + escapeHtml(probability) + ' · Kurs: ' + escapeHtml(odds) +
            ' · Edge: ' + escapeHtml(edge) + ' · Score: ' + escapeHtml(score) +
            '<br>Kryteria: ' + escapeHtml(reasons) + warnings + '</li>';
        }).join("") + '</ul>'
      : "";
    box.innerHTML = '<div class="note"><strong>Brak kwalifikujących się picków.</strong>' +
      '<p>Skan połączył się z backendem, ale żaden typ nie spełnił obecnych kryteriów.</p>' +
      reasonHtml + auditHtml +
      '<p>Nie obniżamy progów w ciemno — najpierw sprawdzamy, co odrzuca kandydatów.</p></div>';
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
        <p class="note"><strong>Liga / turniej:</strong> ${escapeHtml(p.event?.league || p.event?.competition || p.league || "Nieznana")}</p>
        <p><strong>${escapeHtml(p.label || p.key)}</strong> · kurs ${escapeHtml(p.odds)}</p>
        <p>Score: <strong>${escapeHtml(p.score)}</strong> · Edge: <strong>${escapeHtml(p.edge)} pp</strong></p>
        <p>Ruch kursu: <strong>${escapeHtml(movement.movement || "UNKNOWN")}</strong></p>
        <p>WOM: <strong>${escapeHtml(exchange.status || "BRAK")}</strong></p>
        <p>Forma: ${escapeHtml((form.home?.form || []).join("-"))} vs ${escapeHtml((form.away?.form || []).join("-"))}</p>
      </article>
    `;
  }).join("");
}

async function scan(sport = "football", boxId = "cards", buttonId = "scan") {
  const button = $(buttonId);
  if (button) {
    button.disabled = true;
    button.textContent = "Skanowanie…";
  }
  setStatus("Łączenie z backendem…", true);
  try {
    const date = todayWarsaw();
    const market = boxId === "highOddsCards" ? "ALL" : ($("marketType")?.value || "ALL");
    const minOdds = boxId === "highOddsCards" ? Math.max(1.80, Number($("highOddsMin")?.value || 1.80)) : null;
    const highOddsParam = minOdds === null ? "" : `&minOdds=${encodeURIComponent(minOdds)}`;
    const response = await fetch(`${API_URL}/api/scan?date=${date}&market=${encodeURIComponent(market)}&sport=${encodeURIComponent(sport)}${highOddsParam}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (data.error === "SPORTS_ADDON_REQUIRED") throw new Error("BSD wymaga aktywnego dodatku Sports Addon dla tego sportu.");
      if (data.error === "BSD_AUTH_REQUIRED") throw new Error("BSD odrzucił klucz API. Sprawdź konfigurację backendu.");
      throw new Error(data.message || data.error || `HTTP ${response.status}`);
    }
    if (!data || !["BSD", "EXTERNAL_APIS"].includes(data.source)) throw new Error("Backend zwrócił nieoczekiwany format danych.");
    localStorage.setItem("betAnalyzerLastScan", JSON.stringify(data));
    let filtered = sport === "football"
      ? applyFilters(data.picks || [])
      : (data.picks || []).filter(p => Number(p.probability) >= Number($("minProb")?.value || 0)).slice(0, Math.max(1, Number($("limit")?.value || 10)));
    if (boxId === "highOddsCards") {
      const minOdds = Math.max(1.01, Number($("highOddsMin")?.value || 1.80));
      filtered = filtered.filter(p => Number(p.odds) >= minOdds);
    }
    renderCards(filtered, data, boxId);
    if (sport === "football") renderExchange(data);
    saveHistory(data);
    setStatus(`LIVE · ${data.qualifiedEvents ?? data.picks?.length ?? 0} kwalifikujących picków · ${date}`, true);
    renderHistory();
  } catch (error) {
    console.error("Błąd skanu:", error);
    setStatus("Błąd połączenia z backendem", false);
    if ($(boxId)) $(boxId).innerHTML = `<div class="note" style="color:#b91c1c">Nie udało się wykonać skanu: ${escapeHtml(error.message)}</div>`;
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
      if (tab.dataset.tab === "highOdds") scan("football", "highOddsCards", "scanHighOdds");
      if (tab.dataset.tab === "basketball") scan("basketball", "basketballCards", "scanBasketball");
      if (tab.dataset.tab === "tennis") scan("tennis", "tennisCards", "scanTennis");
    });
  });
}

function setup() {
  setupTabs();
  if ($("backend")) $("backend").value = API_URL;
  if ($("scan")) $("scan").addEventListener("click", () => scan("football", "cards", "scan"));
  if ($("scanHighOdds")) $("scanHighOdds").addEventListener("click", () => scan("football", "highOddsCards", "scanHighOdds"));
  if ($("scanBasketball")) $("scanBasketball").addEventListener("click", () => scan("basketball", "basketballCards", "scanBasketball"));
  if ($("scanTennis")) $("scanTennis").addEventListener("click", () => scan("tennis", "tennisCards", "scanTennis"));
  if ($("highOddsMin")) $("highOddsMin").addEventListener("change", () => scan("football", "highOddsCards", "scanHighOdds"));
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
      if (last) {
        const active = document.querySelector(".tab.active")?.dataset.tab || "scanner";
        if (active === "scanner") renderCards(applyFilters(last.picks || []), last, "cards");
      }
    });
  });
  if ($("refresh")) $("refresh").addEventListener("change", scheduleRefresh);
  if ($("mode")) $("mode").textContent = "LIVE";
  scheduleRefresh();
  renderHistory();
}

setup();
