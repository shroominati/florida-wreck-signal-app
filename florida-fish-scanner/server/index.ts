import { createCompatibilityServer } from './compatServer';

const port = Number(process.env.PORT || process.env.COMPAT_SERVER_PORT || 4318);
const host = '0.0.0.0';
const { server } = createCompatibilityServer();

server.listen(port, host, () => {
  console.log(`Compatibility server listening on http://${host}:${port}`);
  console.log('Routes: /health, /v1/capabilities, /v1/grants/mint, /v1/resume/web/grants/mint, /v1/resume/telegram/grants/mint, /v1/invoke, /v1/audit, /v1/history');
});
