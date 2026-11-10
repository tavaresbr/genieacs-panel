import { tdb, tinsertReturningId } from '../config/database.js';
import SgpService from './sgpService.js';
import { WaError } from './whatsappConfigService.js';
import { PERFIS_DE_PLANO, escolherPlanos } from '../utils/wa/planosVenda.js';

const NAME_LIMIT = 80;
const INCLUDES_LIMIT = 300;
const SPEED_MAX = 100000;
const PRICE_MAX_CENTS = 10_000_000;

const invalido = (codigo) => new WaError('whatsapp.salesPlans.invalid', { code: codigo, status: 400 });

const inteiroOuNulo = (valor, max, codigo) => {
  if (valor === undefined) return undefined;
  if (valor === null || valor === '') return null;
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero < 0 || numero > max) throw invalido(codigo);
  return numero;
};

/** Valida o corpo; com `parcial`, só o que veio. */
function ler(corpo, { parcial }) {
  const dados = {};
  if (!parcial || corpo.name !== undefined) {
    const name = String(corpo.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name) throw new WaError('whatsapp.salesPlans.nameRequired', { code: 'sales_plan_name_required', status: 400 });
    if (name.length > NAME_LIMIT) throw invalido('sales_plan_name_too_long');
    dados.name = name;
  }
  const velocidade = inteiroOuNulo(corpo.speedMbps, SPEED_MAX, 'sales_plan_speed_invalid');
  if (velocidade !== undefined) dados.speed_mbps = velocidade;
  const preco = inteiroOuNulo(corpo.priceCents, PRICE_MAX_CENTS, 'sales_plan_price_invalid');
  if (preco !== undefined) dados.price_cents = preco;
  if (corpo.includes !== undefined) {
    const texto = String(corpo.includes ?? '').replace(/\s+/g, ' ').trim();
    if (texto.length > INCLUDES_LIMIT) throw invalido('sales_plan_includes_too_long');
    dados.includes = texto || null;
  }
  if (corpo.profile !== undefined) {
    if (!PERFIS_DE_PLANO.includes(corpo.profile)) throw invalido('sales_plan_profile_invalid');
    dados.profile = corpo.profile;
  }
  if (corpo.active !== undefined) dados.active = corpo.active === true;
  const ordem = inteiroOuNulo(corpo.sortOrder, 1000, 'sales_plan_order_invalid');
  if (ordem !== undefined && ordem !== null) dados.sort_order = ordem;
  return dados;
}

const publico = (linha) => ({
  id: linha.id,
  name: linha.name,
  speedMbps: linha.speed_mbps ?? null,
  priceCents: linha.price_cents ?? null,
  includes: linha.includes ?? '',
  profile: linha.profile,
  active: Boolean(linha.active),
  sortOrder: linha.sort_order ?? 0,
  sgpPlanId: linha.sgp_plan_id ?? null
});

const jaExiste = (error) => /unique|duplicate/i.test(String(error?.code ?? '') + String(error?.message ?? ''));

/**
 * O catálogo de planos da IA de vendas. Tudo por provedor (`tdb`): preço é
 * decisão de cada ISP, e a IA só cita o que está aqui.
 */
class WaSalesPlanService {
  static async list() {
    const linhas = await tdb('wa_sales_plans').orderBy([{ column: 'sort_order' }, { column: 'name' }]);
    // Quem tem preço primeiro, do mais barato ao mais caro; sem preço (a IA não oferece) no fim.
    const semPreco = (p) => (p.price_cents > 0 ? 0 : 1);
    linhas.sort((a, b) => (a.sort_order - b.sort_order) || (semPreco(a) - semPreco(b)) || ((a.price_cents ?? 0) - (b.price_cents ?? 0)));
    return linhas.map(publico);
  }

  static async create(corpo) {
    const dados = ler(corpo ?? {}, { parcial: false });
    const agora = new Date();
    try {
      const id = await tinsertReturningId('wa_sales_plans', { profile: 'equilibrado', active: true, ...dados, created_at: agora, updated_at: agora });
      return publico(await tdb('wa_sales_plans').where({ id }).first());
    } catch (error) {
      if (jaExiste(error)) throw new WaError('whatsapp.salesPlans.duplicate', { code: 'sales_plan_duplicate', status: 409 });
      throw error;
    }
  }

  static async update(id, corpo) {
    const atual = await tdb('wa_sales_plans').where({ id }).first();
    if (!atual) throw new WaError('whatsapp.salesPlans.notFound', { code: 'sales_plan_not_found', status: 404 });
    const dados = ler(corpo ?? {}, { parcial: true });
    try {
      await tdb('wa_sales_plans').where({ id }).update({ ...dados, updated_at: new Date() });
    } catch (error) {
      if (jaExiste(error)) throw new WaError('whatsapp.salesPlans.duplicate', { code: 'sales_plan_duplicate', status: 409 });
      throw error;
    }
    return publico(await tdb('wa_sales_plans').where({ id }).first());
  }

  static async remove(id) {
    const apagadas = await tdb('wa_sales_plans').where({ id }).del();
    if (!apagadas) throw new WaError('whatsapp.salesPlans.notFound', { code: 'sales_plan_not_found', status: 404 });
  }

  /**
   * Traz do SGP os nomes dos planos que ainda não estão aqui. O SGP não manda
   * preço nem velocidade, então entram sem eles — e sem preço a IA não os oferece.
   */
  static async importFromSgp() {
    const itens = await SgpService.listPreRegistrationCatalog('plano');
    const existentes = await tdb('wa_sales_plans').select('name', 'sgp_plan_id');
    const nomes = new Set(existentes.map((p) => String(p.name).toLowerCase()));
    const ids = new Set(existentes.map((p) => p.sgp_plan_id).filter((v) => v != null));
    let criados = 0;
    for (const item of itens) {
      const name = String(item.label ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_LIMIT);
      if (!name || nomes.has(name.toLowerCase()) || ids.has(item.id)) continue;
      const agora = new Date();
      // eslint-disable-next-line no-await-in-loop -- um catálogo pequeno, e a ordem importa pouco
      await tinsertReturningId('wa_sales_plans', {
        name, profile: 'equilibrado', active: true, sgp_plan_id: item.id, created_at: agora, updated_at: agora
      });
      nomes.add(name.toLowerCase());
      criados += 1;
    }
    return { imported: criados, total: itens.length };
  }

  /** Quantos planos a IA pode oferecer agora (ativos e com preço). */
  static async contarOfereciveis() {
    const [{ total }] = await tdb('wa_sales_plans').where({ active: true }).where('price_cents', '>', 0).count({ total: '*' });
    return Number(total) || 0;
  }

  /** Os 0 a 2 planos que a ferramenta `consultar_planos` devolve. */
  static async paraIa(perfil) {
    const linhas = await tdb('wa_sales_plans').where({ active: true }).where('price_cents', '>', 0);
    return escolherPlanos(linhas, perfil);
  }
}

export default WaSalesPlanService;
