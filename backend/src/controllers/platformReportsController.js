import { createResponse, createErrorResponse } from '../utils/helpers.js';
import {
  RevenueRangeError, buildRevenueCsv, buildRevenueReport, parseRange
} from '../services/revenueReportService.js';
import { MetricsRangeError, monthly, parseMonths } from '../services/platformMetricsService.js';
import PlatformAlertService from '../services/platformAlertService.js';
import { ALERT_CHANNELS } from '../services/platformProfileService.js';
import PlatformAudit from '../models/PlatformAudit.js';
import {
  ACCOUNTING_FORMATS, ACCOUNTING_SHEETS, DEFAULT_SHEET, XLSX_CONTENT_TYPE, accountingFilename,
  build as buildAccounting, parseAccountingRange, toAccountingCsv, toAccountingXlsx
} from '../services/accountingExportService.js';

/**
 * Os relatórios do console. Só leitura: nenhum gesto aqui mexe em cobrança ou
 * assinatura, e por isso nenhum vai para a trilha — o que eles mostram já
 * está nela, gesto por gesto.
 */

/** O período recusado (400, com o código que a tela traduz), ou o período. */
function periodoOuRecusa(req, res) {
  try {
    return { range: parseRange(req.query) };
  } catch (error) {
    if (error instanceof RevenueRangeError) {
      res.status(error.status).json(createErrorResponse(error.message, null, error.code));
      return { recusado: true };
    }
    throw error;
  }
}

class PlatformReportsController {
  /** `GET /api/platform/reports/revenue?from&to` — ver `revenueReportService`. */
  static async revenue(req, res) {
    try {
      const { range, recusado } = periodoOuRecusa(req, res);
      if (recusado) return undefined;
      return res.json(createResponse('Revenue report retrieved', await buildRevenueReport(range)));
    } catch (error) {
      console.error('Revenue report error:', error);
      return res.status(500).json(createErrorResponse('Failed to build the revenue report', error.message));
    }
  }

  /** `GET /api/platform/reports/revenue.csv?from&to` — as cobranças do período. */
  static async revenueCsv(req, res) {
    try {
      const { range, recusado } = periodoOuRecusa(req, res);
      if (recusado) return undefined;
      const { csv } = await buildRevenueCsv(range);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="receita-${range.from}-a-${range.to}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      return res.send(csv);
    } catch (error) {
      console.error('Revenue CSV error:', error);
      return res.status(500).json(createErrorResponse('Failed to export the revenue report', error.message));
    }
  }

  /**
   * `GET /api/platform/metrics/monthly?months=1..24` — a série mês a mês (meses
   * de Brasília) que a aba Receita desenha. Ver `platformMetricsService`.
   * 400 `invalid_months`.
   */
  static async monthlyMetrics(req, res) {
    try {
      let months;
      try {
        months = parseMonths(req.query?.months);
      } catch (error) {
        if (error instanceof MetricsRangeError) {
          return res.status(error.status).json(createErrorResponse(error.message, null, error.code));
        }
        throw error;
      }
      return res.json(createResponse('Monthly metrics retrieved', await monthly({ months })));
    } catch (error) {
      console.error('Monthly metrics error:', error);
      return res.status(500).json(createErrorResponse('Failed to build the monthly metrics', error.message));
    }
  }

  /**
   * `POST /api/platform/metrics/monthly-report/send` — manda AGORA o relatório
   * do mês anterior, fora da deduplicação do agendador, pelos `channels`
   * pedidos (sem pedido, os da configuração do relatório). Fica na trilha.
   * 200 `{ month, channels }`; 400 `invalid_channels`; 409 `no_destination`;
   * 502 `send_failed` — como o alerta de teste.
   */
  static async sendMonthlyReport(req, res) {
    try {
      const pedidos = req.body?.channels;
      if (pedidos !== undefined && (!Array.isArray(pedidos) || !pedidos.length
        || pedidos.some((c) => !ALERT_CHANNELS.includes(c)))) {
        return res.status(400).json({ ...createErrorResponse('Invalid channels'), code: 'invalid_channels' });
      }
      const resultado = await PlatformAlertService.sendMonthlyReportNow({ channels: pedidos ?? null });
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLATFORM_MONTHLY_REPORT_SENT,
        detail: { month: resultado.month, status: resultado.status, channels: resultado.channels ?? {} }
      });
      if (resultado.reason === 'no_destination') {
        return res.status(409).json({
          ...createErrorResponse('No WhatsApp or email to send the report to'), code: 'no_destination'
        });
      }
      if (resultado.status !== 'sent') {
        return res.status(502).json({
          ...createErrorResponse('The monthly report could not be sent'), code: 'send_failed', channels: resultado.channels ?? {}
        });
      }
      return res.json(createResponse('Monthly report sent', { month: resultado.month, channels: resultado.channels }));
    } catch (error) {
      console.error('Monthly report send error:', error);
      return res.status(500).json(createErrorResponse('Failed to send the monthly report', error.message));
    }
  }

  /**
   * `GET /api/platform/reports/accounting?from&to|month&format=csv|xlsx&sheet=`
   * — a exportação para a contabilidade (ver `accountingExportService`), como
   * anexo. O XLSX traz as seis abas; o CSV, uma (`sheet`, padrão
   * `cobrancas`). Fica na trilha. 400 `invalid_date`/`invalid_range`/
   * `range_too_long`/`invalid_format`/`invalid_sheet`.
   */
  static async accountingExport(req, res) {
    try {
      const format = String(req.query?.format ?? 'xlsx').toLowerCase();
      if (!ACCOUNTING_FORMATS.includes(format)) {
        return res.status(400).json(createErrorResponse('format must be csv or xlsx', null, 'invalid_format'));
      }
      const sheet = String(req.query?.sheet ?? DEFAULT_SHEET).toLowerCase();
      if (!ACCOUNTING_SHEETS.includes(sheet)) {
        return res.status(400).json(createErrorResponse('Unknown sheet', null, 'invalid_sheet'));
      }
      let range;
      try {
        range = parseAccountingRange(req.query ?? {});
      } catch (error) {
        if (error instanceof RevenueRangeError) {
          return res.status(error.status).json(createErrorResponse(error.message, null, error.code));
        }
        throw error;
      }
      const exportacao = await buildAccounting(range);
      const corpo = format === 'xlsx' ? await toAccountingXlsx(exportacao) : toAccountingCsv(exportacao, sheet);
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLATFORM_ACCOUNTING_EXPORTED,
        detail: { from: range.from, to: range.to, format, ...(format === 'csv' ? { sheet } : {}) }
      });
      res.setHeader('Content-Type', format === 'xlsx' ? XLSX_CONTENT_TYPE : 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${accountingFilename(exportacao, format, sheet)}"`);
      res.setHeader('Cache-Control', 'no-store');
      return res.send(corpo);
    } catch (error) {
      console.error('Accounting export error:', error);
      return res.status(500).json(createErrorResponse('Failed to build the accounting export', error.message));
    }
  }

  /**
   * `POST /api/platform/reports/accounting/send` — manda AGORA a exportação
   * de `month` (padrão: o mês anterior, em Brasília) ao e-mail do contador,
   * fora da deduplicação do agendador. Fica na trilha. 200 `{ month, format }`;
   * 400 `invalid_date`; 409 `no_destination` (sem e-mail do contador); 502
   * `send_failed`.
   */
  static async sendAccounting(req, res) {
    try {
      const month = req.body?.month;
      if (month !== undefined && month !== null
        && !(typeof month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month))) {
        return res.status(400).json(createErrorResponse('month must be YYYY-MM', null, 'invalid_date'));
      }
      const resultado = await PlatformAlertService.sendAccountingNow({ month: month ?? null });
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLATFORM_ACCOUNTING_SENT,
        detail: { month: resultado.month, format: resultado.format, status: resultado.status }
      });
      if (resultado.reason === 'no_destination') {
        return res.status(409).json(createErrorResponse('No accountant email to send the export to', null, 'no_destination'));
      }
      if (resultado.status !== 'sent') {
        return res.status(502).json(createErrorResponse('The accounting export could not be sent', null, 'send_failed'));
      }
      return res.json(createResponse('Accounting export sent', { month: resultado.month, format: resultado.format }));
    } catch (error) {
      console.error('Accounting export send error:', error);
      return res.status(500).json(createErrorResponse('Failed to send the accounting export', error.message));
    }
  }
}

export default PlatformReportsController;
