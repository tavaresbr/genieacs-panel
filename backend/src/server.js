import { app, portalApp, APP_ENV } from './app.js';
import { closePool, testConnection } from './config/database.js';
import { ensureSchema } from './config/schema.js';
import { seedDefaults } from './config/seed.js';
import DeviceService from './services/deviceService.js';
import CustomerService from './services/customerService.js';
import CustomerPortalPasswordService from './services/customerPortalPasswordService.js';
import SchedulerService from './services/schedulerService.js';

const PORT = Number(process.env.APP_PORT) || 5890;
const PORTAL_PORT = process.env.PORTAL_PORT === '0'
  ? 0
  : (Number(process.env.PORTAL_PORT) || 5891);
const HOST = process.env.APP_HOST || '127.0.0.1';
const PORTAL_HOST = process.env.PORTAL_HOST || HOST;

if (PORT !== 0 && PORTAL_PORT !== 0 && PORT === PORTAL_PORT && HOST === PORTAL_HOST) {
  throw new Error('APP_PORT and PORTAL_PORT must be different when using the same host');
}

let server;
let portalServer;

export const startServer = async () => {
  try {
    const dbConnected = await testConnection();

    if (!dbConnected) {
      console.error('Failed to connect to database');
      process.exit(1);
    }

    await ensureSchema();
    await seedDefaults();

    server = app.listen(PORT, HOST, () => {
      console.log(`Server running on ${HOST}:${PORT} (${APP_ENV})`);
      void DeviceService.getDashboardData(false).catch((error) => {
        console.warn(`Dashboard prewarm skipped: ${error.message}`);
      });
      void CustomerService.isAutoGenerationEnabled()
        .then((enabled) => enabled ? DeviceService.getCustomerIdentityDevices() : [])
        .then((devices) => devices.length
          ? CustomerService.syncDevices(devices, { enabled: true })
          : null)
        .catch((error) => {
          console.warn(`Customer ID prewarm skipped: ${error.message}`);
        });
      // Accounts created before portal passwords existed authenticated with a
      // slice of their own Customer ID. Give them real credentials in the
      // background so startup is never blocked by a fleet-sized backfill.
      void CustomerPortalPasswordService.backfillMissing()
        .then((generated) => {
          if (generated > 0) {
            console.log(
              `Generated portal passwords for ${generated} customer account(s); `
              + 'reveal them from the device page before sharing.'
            );
          }
        })
        .catch((error) => {
          console.warn(`Customer portal password backfill skipped: ${error.message}`);
        });
      // The periodic jobs read their own enabled flags, so this starts the
      // driver whether or not the features are on.
      void SchedulerService.start().catch((error) => {
        console.warn(`Background scheduler not started: ${error.message}`);
      });
      console.log(`Panel: http://localhost:${PORT}`);
    });
    portalServer = portalApp.listen(PORTAL_PORT, PORTAL_HOST, () => {
      const address = portalServer.address();
      const activePort = typeof address === 'object' && address ? address.port : PORTAL_PORT;
      console.log(`Customer portal: http://localhost:${activePort}`);
    });
    return server;
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down`);
  SchedulerService.stop();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (portalServer) {
    await new Promise((resolve) => portalServer.close(resolve));
  }
  await closePool();
  process.exit(0);
}

process.once('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    console.error('Graceful shutdown failed:', error);
    process.exit(1);
  });
});
process.once('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    console.error('Graceful shutdown failed:', error);
    process.exit(1);
  });
});

export default app;
