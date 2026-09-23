const API_URL = "https://bet-analyzer-backend-5g31.onrender.com";

async function loadData() {
  try {
    const response = await fetch(`${API_URL}/api/scan`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    render(data.results || []);
  } catch (error) {
    console.error("Błąd API:", error);

    const app = document.getElementById("app");

    if (app) {
      app.innerHTML = `
        <div style="padding:20px">
          <h2>Bet Analyzer Live</h2>
          <p style="color:red">
            Nie udało się pobrać danych z API.
          </p>
          <p>${error.message}</p>
        </div>
      `;
    }
  }
}

function render(results) {
  const app = document.getElementById("app");

  if (!app) {
    console.error("Nie znaleziono elementu #app");
    return;
  }

  app.innerHTML = `
    <div style="padding:20px;font-family:Arial,sans-serif">
      <h1>Bet Analyzer Live</h1>

      <p style="color:green">
        🟢 Backend połączony
      </p>

      ${results.map(item => `
        <div style="
          border:1px solid #ddd;
          border-radius:12px;
          padding:15px;
          margin:12px 0;
        ">
          <h3>${item.event}</h3>

          <p><strong>Rynek:</strong> ${item.market}</p>
          <p><strong>Kurs:</strong> ${item.odds}</p>
          <p><strong>Prawdopodobieństwo:</strong> ${item.probability}%</p>
          <p><strong>Edge:</strong> ${item.edge}%</p>
          <p><strong>Płynność:</strong> ${item.liquidity}</p>
          <p><strong>Back:</strong> ${item.back}</p>
          <p><strong>Lay:</strong> ${item.lay}</p>
          <p><strong>LTP:</strong> ${item.ltp}</p>
          <p><strong>Presja:</strong> ${item.pressure}</p>
        </div>
      `).join("")}
    </div>
  `;
}

loadData();
