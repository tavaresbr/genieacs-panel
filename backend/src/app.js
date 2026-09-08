import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { testConnection } from './config/database.js';
import { IS_SELF_HOSTED } from './config/edition.js';
import { TRUST_PROXY } from './config/proxy.js';
import { attachLocale } from './middleware/locale.js';
import { resolveTenant } from './middleware/tenantResolver.js';
import { DEFAULT_LOCALE, translate, translateError } from './i18n/index.js';
import {
  apiLimiter,
  authLimiter,
  portalIpLimiter,
  portalLoginLimiter
} from './middleware/rateLimit.js';

import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';
import settingsRoutes from './routes/settings.js';
import vendorRoutes from './routes/vendors.js';
import mappingRoutes from './routes/mapping.js';
import mapSettingsRoutes from './routes/mapSettings.js';
import databaseRoutes from './routes/database.js';
import userRoutes from './routes/users.js';
import customerPortalRoutes from './routes/customerPortal.js';
import sgpRoutes from './routes/sgp.js';
import whatsappRoutes from './routes/whatsapp.js';
import whatsappMessageRoutes from './routes/whatsappMessages.js';
import whatsappAlertRoutes from './routes/whatsappAlerts.js';
import whatsappBillingRoutes from './routes/whatsappBilling.js';
import whatsappWebhookRoutes from './routes/whatsappWebhook.js';
import provisioningRoutes from './routes/provisioning.js';
import { WEBHOOK_PATH } from './services/sgpService.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const app = express();
export const portalApp = express();

export const APP_ENV = process.env.APP_ENV || 'development';
export const FRONTEND_DIR = process.env.FRONTEND_DIR
  || path.join(__dirname, '..', '..', 'frontend', 'dist');
export const APP_VERSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
).version;

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5890')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const helmetOptions = {
  // COOP is ignored on plain HTTP public-IP deployments and OAC can produce
  // persistent browser warnings when an origin previously used site-keying.
  // SkyGenPanel does not rely on cross-origin isolation, so omit both headers.
  crossOriginOpenerPolicy: false,
  originAgentCluster: false,
  referrerPolicy: {
    policy: 'strict-origin-when-cross-origin'
  },
  contentSecurityPolicy: {
    directives: {
      // Vite emits external hashed modules, so inline scripts remain blocked.
      scriptSrc: ["'self'"],
      // The built-in server defaults to HTTP; upgrading relative assets would
      // make browsers request HTTPS from a port that has no TLS listener.
      upgradeInsecureRequests: null,
      imgSrc: [
        "'self'",
        'data:',
        'blob:',
        'https://tile.openstreetmap.org',
        'https://*.basemaps.cartocdn.com',
        'https://mt1.google.com'
      ],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"]
    }
  }
};

function configureSecurity(target) {
  target.disable('x-powered-by');
  if (TRUST_PROXY !== null) {
    target.set('trust proxy', TRUST_PROXY);
  }
  target.use(helmet(helmetOptions));
  target.use((req, res, next) => {
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()'
    );
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
    }
    next();
  });
}

configureSecurity(app);
configureSecurity(portalApp);

function isAllowedOrigin(req, origin) {
  if (!origin) return true;
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return true;

  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

app.use(attachLocale);

app.use((req, res, next) => {
  const origin = req.get('origin');
  if (!isAllowedOrigin(req, origin)) {
    return res.status(403).json({
      success: false,
      message: req.t('common.originNotAllowed')
    });
  }
  return next();
});

app.use(cors({
  origin: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
}));
// The webhook signature covers the exact bytes SGP signed, so this route has
// to see the raw body. Mounting `express.raw` on the path before the global
// JSON parser is what reserves it: body-parser marks the body as read, so the
// parser below skips it. A `verify` hook on the global parser would instead
// copy every request body in the process.
app.use(WEBHOOK_PATH, express.raw({ type: '*/*', limit: '64kb' }));
app.use(express.json({ limit: '1mb' }));

// Mounted BEFORE the shared `apiLimiter` on purpose. The Evolution server is a
// server, not a browser session: it authenticates with the token in its own
// query string, so this route stays outside `authenticateToken`, and its normal
// burst — a QR rotation every 20 s, one receipt per recipient per delivery
// state — would trip a 300/min bucket sized for a human clicking around. It
// declares its own, much higher, ceiling instead.
app.use('/api/whatsapp-webhook', whatsappWebhookRoutes);

app.use('/api', apiLimiter);

// Health answers before a provider is resolved, deliberately. It reports
// whether the database is reachable, and resolving the provider is itself a
// database read — behind the resolver, an unreachable database would answer a
// blank 500 instead of naming the thing that is down.
app.get('/api/health', async (req, res) => {
  const database = await testConnection();
  res.status(database ? 200 : 503).json({
    status: database ? 'ok' : 'degraded',
    database: database ? 'ok' : 'unavailable',
    timestamp: new Date().toISOString(),
    version: APP_VERSION
  });
});

app.use('/api', resolveTenant);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/refresh', authLimiter);
app.use('/api/auth/setup', authLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/vendor-management', vendorRoutes);
app.use('/api/mapping-data', mappingRoutes);
app.use('/api/map-settings', mapSettingsRoutes);
// Switching databases copies the panel into the target and wipes whatever was
// there first, which is a reasonable thing to offer an ISP that owns its own
// install and a catastrophic one on a deployment shared by several. The route
// only exists in the self-hosted edition.
if (IS_SELF_HOSTED) {
  app.use('/api/database', databaseRoutes);
}
app.use('/api/users', userRoutes);
app.use('/api/sgp', sgpRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/whatsapp', whatsappMessageRoutes);
app.use('/api/whatsapp', whatsappAlertRoutes);
app.use('/api/whatsapp', whatsappBillingRoutes);
app.use('/api/provisioning', provisioningRoutes);

app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: req.t('common.routeNotFound') });
});

function serveFrontend(target, htmlFile) {
  if (!fs.existsSync(FRONTEND_DIR)) return false;
  target.use(express.static(FRONTEND_DIR, {
    dotfiles: 'deny',
    index: false,
    maxAge: APP_ENV === 'production' ? '1h' : 0,
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  }));
  const htmlPath = path.join(FRONTEND_DIR, htmlFile);
  target.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) || path.extname(req.path)) {
      return next();
    }
    if (!fs.existsSync(htmlPath)) {
      return res.status(503).send(req.t('common.buildUnavailable'));
    }
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(htmlPath);
  });
  return true;
}

// `next` is unused but required: Express only treats a four-argument function
// as an error handler.
export function errorHandler(err, req, res, next) {
  console.error('Unhandled error:', err);
  // A failure raised before the locale middleware ran leaves `req.t` unset.
  const t = req.t || ((key) => translate(DEFAULT_LOCALE, key));
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false,
      message: t('common.invalidJson')
    });
  }
  const status = err.status || 500;
  // Internal messages are revealed only when the deployment explicitly asks
  // for them; APP_ENV is unset on most installs, so "not production" would
  // leak them by default.
  res.status(status).json({
    success: false,
    message: status >= 500 && APP_ENV !== 'development'
      ? t('common.internalError')
      : (translateError(t, err) || t('common.internalError'))
  });
}

if (!serveFrontend(app, 'index.html')) {
  console.warn(`Frontend build not found at ${FRONTEND_DIR}; serving API only`);
}
app.use(errorHandler);

function portalOriginGuard(req, res, next) {
  const origin = req.get('origin');
  if (origin && !isAllowedOrigin(req, origin)) {
    return res.status(403).json({ success: false, message: req.t('common.originNotAllowed') });
  }
  const fetchSite = req.get('sec-fetch-site');
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
    fetchSite &&
    !['same-origin', 'none'].includes(fetchSite)
  ) {
    return res.status(403).json({ success: false, message: req.t('common.crossSiteBlocked') });
  }
  return next();
}

portalApp.use(attachLocale);
portalApp.use(portalOriginGuard);
portalApp.use(express.json({ limit: '16kb' }));
// The login limiter keys on the submitted customer ID, so it must see a parsed body.
portalApp.use('/api/customer/login', portalLoginLimiter);
portalApp.use('/api', portalIpLimiter);
// Ahead of the resolver for the same reason as the panel's.
portalApp.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'customer-portal', version: APP_VERSION });
});
portalApp.use('/api', resolveTenant);
portalApp.use('/api/customer', customerPortalRoutes);
portalApp.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: req.t('common.routeNotFound') });
});

serveFrontend(portalApp, 'portal.html');
portalApp.use(errorHandler);

export default app;
