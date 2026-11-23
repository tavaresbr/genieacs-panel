import { tdb, tinsertReturningId } from '../config/database.js';

/**
 * O bot do Telegram dos CLIENTES do provedor (um por provedor). O token fica
 * cifrado na coluna e não sai do servidor: quem entrega o bot ao navegador passa
 * por `TelegramCustomerBotService.publicBot()`.
 */
class TelegramCustomerBot {
  static async get() {
    return (await tdb('telegram_customer_bots').first()) || null;
  }

  static async create(row) {
    const id = await tinsertReturningId('telegram_customer_bots', row);
    return (await tdb('telegram_customer_bots').where({ id }).first()) || null;
  }

  static async update(id, patch) {
    await tdb('telegram_customer_bots').where({ id }).update({ ...patch, updated_at: new Date() });
    return (await tdb('telegram_customer_bots').where({ id }).first()) || null;
  }

  static async remove(id) {
    return tdb('telegram_customer_bots').where({ id }).del();
  }
}

export default TelegramCustomerBot;
