import express from 'express';
import WhatsAppMessageController from '../controllers/whatsappMessageController.js';
import WhatsAppAttachmentController from '../controllers/whatsappAttachmentController.js';
import WhatsAppMediaController from '../controllers/whatsappMediaController.js';
import WhatsAppSubscriberController from '../controllers/whatsappSubscriberController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';
import { sgpAdminLimiter, whatsappBulkRequeueLimiter, whatsappSendLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

// Ler a caixa é `whatsapp.read` e responder é `whatsapp.send`: atender
// assinante é justamente o trabalho do plantão. A linha entre as duas é que
// mandar mensagem do número do provedor é falar COMO o provedor.
router.get(
  '/conversations',
  authenticateToken,
  requirePermission('whatsapp.read'),
  WhatsAppMessageController.listConversations
);

// Reading a thread clears its unread count, which is why this is a GET that
// writes: the operator looking at it is the only thing "read" can mean.
router.get(
  '/conversations/:id/messages',
  authenticateToken,
  requirePermission('whatsapp.read'),
  WhatsAppMessageController.listMessages
);

// Filing, not deleting: the thread and its history stay, and an inbound
// message takes it back out of the archive on its own.
router.post(
  '/conversations/:id/status',
  authenticateToken,
  requirePermission('whatsapp.send'),
  WhatsAppMessageController.setStatus
);

// Which subscriber a thread belongs to, said by hand — for the number the SGP
// does not know. Asking to save that number on the contract is checked again
// in the controller, against the billing screen's own permission.
router.post(
  '/conversations/:id/subscriber',
  authenticateToken,
  requirePermission('whatsapp.send'),
  WhatsAppMessageController.linkSubscriber
);

// The SGP's subscribers as contacts. Reading is inbox work, like the list of
// conversations; opening a thread is `whatsapp.send`, because the next thing
// the operator does in it is speak as the provider.
router.get(
  '/contacts',
  authenticateToken,
  requirePermission('whatsapp.read'),
  WhatsAppMessageController.listContacts
);

router.post(
  '/contacts/:contract/conversation',
  authenticateToken,
  requirePermission('whatsapp.send'),
  WhatsAppMessageController.openContactConversation
);

router.post(
  '/conversations/:id/messages',
  authenticateToken,
  requirePermission('whatsapp.send'),
  whatsappSendLimiter,
  WhatsAppMessageController.send
);

// The SGP module beside the thread. Reading takes both the inbox and the ERP:
// a `whatsapp.read` operator without `sgp.read` sees the thread, not the
// contract behind it. Every act on the ERP is `sgp.act`, as on the device page,
// and rides the same budget as the device page's SGP routes, since each one is
// a call to the provider.
router.get(
  '/conversations/:id/subscriber',
  authenticateToken,
  requirePermission('whatsapp.read'),
  requirePermission('sgp.read'),
  sgpAdminLimiter,
  WhatsAppSubscriberController.get
);

router.post(
  '/conversations/:id/subscriber/bind',
  authenticateToken,
  requirePermission('whatsapp.read'),
  requirePermission('sgp.act'),
  sgpAdminLimiter,
  WhatsAppSubscriberController.bind
);

router.post(
  '/conversations/:id/subscriber/unlock',
  authenticateToken,
  requirePermission('whatsapp.read'),
  requirePermission('sgp.act'),
  sgpAdminLimiter,
  WhatsAppSubscriberController.unlock
);

// The billing text is only ever handed back to the composer: `whatsapp.send`
// because the only use of it is a message, `sgp.read` because it reads the ERP.
router.post(
  '/conversations/:id/subscriber/second-copy',
  authenticateToken,
  requirePermission('whatsapp.send'),
  requirePermission('sgp.read'),
  sgpAdminLimiter,
  WhatsAppSubscriberController.secondCopy
);

// The same capability the billing screen asks for the same write.
router.post(
  '/conversations/:id/subscriber/phone',
  authenticateToken,
  requirePermission('whatsapp.read'),
  requirePermission('campaigns.manage'),
  sgpAdminLimiter,
  WhatsAppSubscriberController.savePhone
);

router.post(
  '/conversations/:id/subscriber/ticket',
  authenticateToken,
  requirePermission('whatsapp.read'),
  requirePermission('sgp.act'),
  sgpAdminLimiter,
  WhatsAppSubscriberController.ticket
);

// The operator's file, one step ahead of the message that carries it. The body
// is the raw file and the parser for it is mounted in `app.js`, on this exact
// path and BEFORE the global JSON one — see `waAttachmentService`. Here the
// request is already past `apiLimiter` and the provider resolver, and the
// answer is the `{ path, type, name }` the send route takes back as
// `attachment`. No table is touched, so nothing here needs scoping of its own:
// the row that will point at this file is written by the send route, into
// `wa_messages`, which is scoped.
router.post(
  '/attachments',
  authenticateToken,
  requirePermission('whatsapp.send'),
  WhatsAppAttachmentController.upload
);

// The bytes of one message's attachment, for the operator looking at the
// thread. Session-authenticated and provider-scoped like its neighbours — the
// Evolution server fetches the same file from `/api/whatsapp-media/:id`, which
// is a different route with a different credential precisely because it is a
// different audience.
router.get(
  '/messages/:id/media',
  authenticateToken,
  requirePermission('whatsapp.read'),
  WhatsAppMediaController.fetch
);

// "Send it again", meaning THIS row and not a copy of it.
//
// The screen's old resend read the row's body and posted a new message, which
// left the failed row behind, gave the subscriber the same message twice, and
// did nothing at all when the content was an attachment with no caption —
// there was no body to read, so the button was silent. Requeuing keeps the id,
// the file, the `source` and the place in the thread.
//
// Provider-scoped by the resolver like everything else here: `WaMessage`
// reads through `tdb`, so another provider's id is not forbidden on this
// route, it does not exist.
router.post(
  '/messages/:id/requeue',
  authenticateToken,
  requirePermission('whatsapp.send'),
  whatsappSendLimiter,
  WhatsAppMessageController.requeue
);

// The same act at the size failure actually arrives in: an Evolution restart
// during a dunning run fails thousands of rows at once, and requeuing them one
// press at a time is not a recovery.
//
// The path has one segment where the route above has two, so no id can be
// mistaken for it and it needs no ordering trick to stay reachable.
// Teto próprio, e muito mais apertado que o da vizinha: aquela enfileira uma
// linha, esta pode enfileirar milhares.
router.post(
  '/messages/requeue-failed',
  authenticateToken,
  requirePermission('whatsapp.send'),
  whatsappBulkRequeueLimiter,
  WhatsAppMessageController.requeueFailed
);

// A varredura de anexos, sob demanda. `whatsapp.config` e não `whatsapp.send`,
// por um motivo mais duro que o das vizinhas: esta é a única rota da integração
// que apaga alguma coisa. What it deletes is fixed by the retention window in
// Settings — the request carries no parameters at all — so the button is
// "apply the policy now", never "choose one".
router.post(
  '/media/sweep',
  authenticateToken,
  requirePermission('whatsapp.config'),
  WhatsAppMediaController.sweep
);

export default router;
