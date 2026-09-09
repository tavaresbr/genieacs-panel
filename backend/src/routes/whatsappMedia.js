import express from 'express';

const router = express.Router();

// Placeholder: the signed media route the Evolution server fetches. The
// contract is frozen in `docs/whatsapp-api-contract.md` under "Anexos"; the
// handler lands with the rest of wave 6, and until then the address exists and
// says nothing.
router.get('/:id', (req, res) => {
  res.status(404).json({ success: false, message: req.t('common.routeNotFound') });
});

export default router;
