import { tdb } from '../config/database.js';
import { REPORT_PERIODS } from './waBotReportService.js';
import { MOTIVOS_DE_PERDA } from './waConversationService.js';

const TOP_ITENS = 5;

/**
 * O relatório de vendas da IA: das conversas em que ela registrou interesse
 * comercial (`lead_at`) no período, quantas fecharam, quantas se perderam e por
 * quê. Tudo do provedor atual (`tdb`); nada lê o SGP.
 *
 * Conversão = fecharam ÷ leads: quem ainda não teve resultado conta como lead
 * em aberto, e o número sobe quando a equipe encerra e marca.
 */
class WaSalesReportService {
  static async report({ days = 30, now = new Date() } = {}) {
    const periodo = REPORT_PERIODS.includes(Number(days)) ? Number(days) : 30;
    const desde = new Date(now.getTime() - periodo * 24 * 60 * 60 * 1000);

    const leads = await tdb('wa_conversations')
      .where('lead_at', '>=', desde)
      .select('lead_outcome', 'lead_lost_reason', 'lead_plan_id');

    const motivos = Object.fromEntries(MOTIVOS_DE_PERDA.map((m) => [m, 0]));
    const porPlano = new Map();
    let fecharam = 0;
    let perderam = 0;
    for (const lead of leads) {
      if (lead.lead_outcome === 'won') {
        fecharam += 1;
        if (lead.lead_plan_id) porPlano.set(lead.lead_plan_id, (porPlano.get(lead.lead_plan_id) ?? 0) + 1);
      } else if (lead.lead_outcome === 'lost') {
        perderam += 1;
        if (lead.lead_lost_reason in motivos) motivos[lead.lead_lost_reason] += 1;
      }
    }

    const nomes = porPlano.size
      ? new Map((await tdb('wa_sales_plans').whereIn('id', [...porPlano.keys()]).select('id', 'name')).map((p) => [p.id, p.name]))
      : new Map();
    const planos = [...porPlano.entries()]
      .map(([id, vendas]) => ({ planId: id, name: nomes.get(id) ?? null, sales: vendas }))
      .sort((a, b) => b.sales - a.sales)
      .slice(0, TOP_ITENS);

    // O uso é acumulado (não por período): diz o que a IA mais usa da base.
    const itens = await tdb('wa_ai_knowledge').where('uses', '>', 0).orderBy('uses', 'desc').limit(TOP_ITENS).select('id', 'title', 'kind', 'uses');

    return {
      days: periodo,
      leads: leads.length,
      won: fecharam,
      lost: perderam,
      open: leads.length - fecharam - perderam,
      conversionRate: leads.length ? Math.round((fecharam / leads.length) * 1000) / 10 : null,
      lostReasons: motivos,
      topPlans: planos,
      topKnowledge: itens.map((i) => ({ id: i.id, title: i.title, kind: i.kind, uses: i.uses }))
    };
  }
}

export default WaSalesReportService;
