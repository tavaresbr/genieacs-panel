import { createResponse, createErrorResponse } from '../utils/helpers.js';
import PlatformOverviewService from '../services/platformOverviewService.js';

/**
 * O painel inicial do console (aba Início). Só leitura, como os relatórios:
 * nada aqui vai para a trilha. Um bloco que falha volta `null` (e o nome em
 * `errors`) sem derrubar o pedido — ver `platformOverviewService`.
 */
class PlatformOverviewController {
  /** `GET /api/platform/overview`. */
  static async overview(req, res) {
    try {
      return res.json(createResponse('Platform overview retrieved', await PlatformOverviewService.build()));
    } catch (error) {
      console.error('Platform overview error:', error);
      return res.status(500).json(createErrorResponse('Failed to build the platform overview', error.message));
    }
  }
}

export default PlatformOverviewController;
