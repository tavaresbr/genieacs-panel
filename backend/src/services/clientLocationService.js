import { tdb } from '../config/database.js';
import SgpClient from '../models/SgpClient.js';
import SgpLink from '../models/SgpLink.js';
import SgpService from './sgpService.js';
import { geocodeAddress } from './addressLookupService.js';

/**
 * Onde fica a casa de um cliente, para o "Colocar no mapa" abrir já nela.
 *
 * O endereço vem do SGP, pela ordem do que custa menos:
 * 1. `sgp_contacts` pelo login PPPoE — o que a sincronização de contatos já
 *    guardou, sem consulta nenhuma;
 * 2. pelo contrato vinculado ao equipamento (`sgp_links`);
 * 3. o SGP ao vivo, pelo login, quando a integração está pronta.
 *
 * Um contrato sem endereço próprio está no endereço do cliente dono dele
 * (`sgp_clients`), como a sincronização já faz.
 *
 * Com coordenadas no SGP, o ponto é esse. Sem elas, as partes do endereço vão
 * ao Nominatim (`geocodeAddress`: rua e número, depois só a cidade). Falhar
 * ali não é erro: volta o endereço sem ponto, e a tela deixa buscar.
 */
const parseJson = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const text = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

function coordinates(parts) {
  const lat = Number(parts?.latitude);
  const lng = Number(parts?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function lineOf(parts) {
  if (!parts) return null;
  if (parts.line) return text(parts.line) || null;
  const street = [parts.street, parts.number].filter(Boolean).join(', ');
  const place = [parts.district, [parts.city, parts.state].filter(Boolean).join('/')].filter(Boolean).join(' - ');
  return [street, parts.complement, place, parts.zip].filter(Boolean).join(' · ') || null;
}

async function contactByLogin(login) {
  if (!login) return null;
  return (await tdb('sgp_contacts').whereRaw('LOWER(TRIM(login)) = ?', [login]).orderBy('id', 'desc').first()) || null;
}

async function contactByDevice(deviceId) {
  if (!deviceId) return null;
  const link = await SgpLink.getByDeviceId(deviceId);
  if (!link?.contract) return null;
  return (await tdb('sgp_contacts').where({ contract: link.contract }).first())
    || { contract: link.contract, client_name: link.client_name };
}

/** O endereço em partes de um contato, ou o do cliente dono dele. */
async function addressOfContact(contact) {
  const own = parseJson(contact.address_parts);
  if (own && (coordinates(own) || own.street || own.city)) return { parts: own, line: text(contact.address) || lineOf(own) };
  if (contact.client_ref) {
    const parsed = await SgpClient.getBySgpId(contact.client_ref).catch(() => null);
    const clientAddress = parsed?.overrides?.address && typeof parsed.overrides.address === 'object'
      ? parsed.overrides.address
      : parsed?.address;
    if (clientAddress && typeof clientAddress === 'object') {
      return { parts: clientAddress, line: text(contact.address) || lineOf(clientAddress) };
    }
  }
  return { parts: own, line: text(contact.address) || lineOf(own) };
}

async function liveContract(login) {
  const config = await SgpService.getConfig().catch(() => null);
  if (!config || !SgpService.isReady(config)) return null;
  try {
    const { contracts } = await SgpService.lookupCustomer({ login });
    const contract = contracts[0] ? SgpService.publicContract(contracts[0]) : null;
    if (!contract) return null;
    return { contract: contract.contract, client_name: contract.name, address: contract.address, address_parts: contract.addressParts };
  } catch {
    return null;
  }
}

class ClientLocationService {
  static async locate({ pppoe, deviceId }) {
    const login = text(pppoe).toLowerCase();
    const contact = (await contactByLogin(login)) || (await contactByDevice(text(deviceId))) || (login ? await liveContract(login) : null);
    if (!contact) return { found: false };

    const { parts, line } = await addressOfContact(contact);
    const base = {
      found: true,
      contract: contact.contract ?? null,
      clientName: text(contact.client_name) || null,
      address: line || null
    };
    const point = coordinates(parts);
    if (point) return { ...base, ...point, precision: 'sgp' };
    if (!parts?.city) return base;
    try {
      const result = await geocodeAddress({
        addressLine: parts.street,
        addressNumber: parts.number,
        city: parts.city,
        state: parts.state,
        postalCode: parts.zip
      });
      return result.found ? { ...base, lat: result.data.lat, lng: result.data.lng, precision: result.data.precision } : base;
    } catch {
      return base;
    }
  }
}

export default ClientLocationService;
