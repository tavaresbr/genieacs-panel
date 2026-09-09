import { app, portalApp, APP_ENV } from './app.js';
import { closePool, testConnection } from './config/database.js';
import { ensureSchema } from './config/schema.js';
import { seedDefaults } from './config/seed.js';
import DeviceService from './services/deviceService.js';
import CustomerService from './services/customerService.js';
import CustomerPortalPasswordService from './services/customerPortalPasswordService.js';
import SchedulerService from './services/schedulerService.js';
import WaOutboxWorker from './services/waOutboxWorker.js';
import WaAlertService from './services/waAlertService.js';
import WaBroadcastService from './services/waBroadcastService.js';
import { forEachTenant, forSoleTenant } from './config/tenantJobs.js';

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
      // Every boot job below opens a provider scope: none has a request, and
      // the queries under them refuse to run without one. Which primitive each
      // takes is not a style choice — `forEachTenant` divides the work, and is
      // only correct once everything the job reads is itself per provider.
      //
      // The prewarm qualifies now: the GenieACS it reads comes from
      // `settings.genieAcsUrl`, which is per provider, and the accounts it
      // joins against are too.
      void forEachTenant(() => DeviceService.getDashboardData(false))
        .catch((error) => {
          console.warn(`Dashboard prewarm skipped: ${error.message}`);
        });
      // The Customer ID sweep does NOT qualify yet, and the reason is sharper
      // than a stale read: `CustomerService.retireAccount` calls
      // `SgpLink.deleteByDeviceId`, and `sgp_links` is still deployment-wide.
      // Looped per provider, retiring an account would delete another
      // provider's link for the same device id — and device ids now come from
      // each provider's own GenieACS, so they can collide. It also reads
      // `device_profiles`, equally unscoped. Both move in the slice that
      // scopes them.
      void forSoleTenant('The Customer ID sweep', async () => {
        if (!await CustomerService.isAutoGenerationEnabled()) return null;
        const devices = await DeviceService.getCustomerIdentityDevices();
        return devices.length ? CustomerService.syncDevices(devices, { enabled: true }) : null;
      }).catch((error) => {
        console.warn(`Customer ID prewarm skipped: ${error.message}`);
      });
      // Accounts created before portal passwords existed authenticated with a
      // slice of their own Customer ID. Give them real credentials in the
      // background so startup is never blocked by a fleet-sized backfill.
      void forEachTenant(() => CustomerPortalPasswordService.backfillMissing())
        .then((counts) => {
          const generated = counts.reduce((total, one) => total + one, 0);
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
      // The WhatsApp outbox has its own loop rather than a job inside the
      // scheduler: it runs every few seconds because a reply an operator just
      // typed is waiting on it, while every scheduler job is on a minute or
      // longer. It reads the integration's enabled flag inside each tick, so
      // this arms the driver whether or not WhatsApp is configured.
      WaOutboxWorker.start();
      // The technical-alert scan has its own driver for the opposite reason to
      // the outbox: a pass reads the whole fleet from GenieACS, so it is paced
      // by the operator's `intervalSeconds` rather than by a fixed tick. Like
      // the others it reads its enabled flag inside the tick, so this arms the
      // driver whether or not alerts are configured.
      WaAlertService.start();
      // The campaign flush loop is a separate driver on a separate clock: it
      // ticks once a minute because a campaign's budget is written per minute,
      // and it only ever hands recipients to the outbox above. It reads the
      // integration's enabled flag inside each tick, like the worker does.
      WaBroadcastService.start();
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
  WaOutboxWorker.stop();
  WaAlertService.stop();
  WaBroadcastService.stop();
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
