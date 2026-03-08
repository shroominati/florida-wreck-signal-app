# Florida Wreck Signal

Standalone deployable maritime research app covering Florida Keys to Daytona.

## Run

```bash
npm install
npm run wreck:start
```

Open [http://localhost:8899](http://localhost:8899).

## Auth

HTTP Basic Auth is enabled by default.

- Username: `admin`
- Password: `georgeeatsgold`

Override with environment variables:

```bash
WRECK_APP_USER=admin
WRECK_APP_PASSWORD=georgeeatsgold
WRECK_APP_AUTH_ENABLED=true
```

## Render

- Runtime: `Node`
- Build command: `npm install`
- Start command: `npm run wreck:start`
- Health check path: `/healthz`

Environment variables:

- `WRECK_APP_USER=admin`
- `WRECK_APP_PASSWORD=georgeeatsgold`
- `WRECK_APP_AUTH_ENABLED=true`

## Included Files

- `server/wreck-app.js`
- `server/wreck-db.js`
- `maritime/`
- `data/wreck-research-db.json`
- `scripts/import-maritime-data.js`
