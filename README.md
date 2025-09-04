## TOTAL LLP Position Server

An Express server that fetches the LLP account data from the Lighter mainnet API and displays the sum of all `position_value` fields as "TOTAL LLP Position".

### Endpoints
- `/` A styled HTML page showing the formatted total with auto-refresh.
- `/api/llp-total` JSON with `{ total, count, source, account_index }`.

### Upstream API
- `https://mainnet.zklighter.elliot.ai/api/v1/account?by=index&value=281474976710654`

### Requirements
- Node.js 16+

### Setup
```bash
npm install
```

### Run
```bash
npm start
# Visit http://localhost:3000
```

### Notes
- The home page auto-refreshes every 30 seconds.
- No browser automation or scraping is used; data comes directly from the API.