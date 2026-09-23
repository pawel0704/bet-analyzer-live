# Backend

Node 20+ / Express.

1. Copy `.env.example` to `.env`.
2. Fill `SPORTMONKS_TOKEN`, `BETFAIR_APP_KEY`, `BETFAIR_SESSION_TOKEN`.
3. Run `npm install`.
4. Run `npm start`.
5. Put the public backend URL into the PWA Settings.

Betfair live Stream API can later replace polling for lower latency. The current MVP deliberately uses `listMarketCatalogue` + `listMarketBook` polling and computes movement from successive snapshots.
