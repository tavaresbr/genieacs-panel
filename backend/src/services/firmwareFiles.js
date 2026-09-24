/**
 * Quais firmwares do GenieACS servem para uma ONT.
 *
 * Os arquivos já moram no GenieACS: o provedor sobe pela tela dele, com o tipo
 * "1 Firmware Upgrade Image", e, se preencher, o fabricante (OUI), o modelo
 * (product class) e a versão. O painel só escolhe entre eles e manda a tarefa
 * `download`.
 *
 * A regra é conservadora de propósito, porque o erro aqui não tem volta: um
 * firmware de outro modelo pode deixar a ONT sem subir, e aí é visita técnica.
 * Serve o arquivo que diz o MESMO modelo da ONT e, se disser o fabricante,
 * o mesmo fabricante. Arquivo sem modelo não serve para ninguém — o painel não
 * adivinha —, e a tela conta quantos ficaram de fora para o operador saber que
 * existem e por que não aparecem.
 */

export const FIRMWARE_FILE_TYPE = '1 Firmware Upgrade Image';

const igual = (a, b) => String(a ?? '').trim().toUpperCase() === String(b ?? '').trim().toUpperCase();
const vazio = (value) => String(value ?? '').trim() === '';

/** O arquivo, no formato que a tela lê. */
function publicFile(file) {
  const meta = file?.metadata ?? {};
  return {
    id: String(file._id),
    version: vazio(meta.version) ? null : String(meta.version).trim().slice(0, 128),
    oui: vazio(meta.oui) ? null : String(meta.oui).trim().slice(0, 16),
    productClass: vazio(meta.productClass) ? null : String(meta.productClass).trim().slice(0, 64),
    size: Number.isFinite(Number(file.length)) ? Number(file.length) : null,
    uploadedAt: file.uploadDate ? String(file.uploadDate) : null
  };
}

/**
 * Separa os firmwares que servem para esta ONT dos que não servem.
 *
 * @param {Array<object>} files os documentos da coleção `files` do GenieACS
 * @param {{ oui?: string|null, productClass?: string|null }} device
 * @returns {{ compatible: object[], otherModels: number }}
 */
export function compatibleFirmware(files, device) {
  const compatible = [];
  let otherModels = 0;
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || file._id === undefined || file._id === null) continue;
    const meta = file.metadata ?? {};
    if (!igual(meta.fileType, FIRMWARE_FILE_TYPE)) continue;
    const modeloConfere = !vazio(meta.productClass) && !vazio(device?.productClass)
      && igual(meta.productClass, device.productClass);
    const fabricanteConfere = vazio(meta.oui) || (!vazio(device?.oui) && igual(meta.oui, device.oui));
    if (modeloConfere && fabricanteConfere) compatible.push(publicFile(file));
    else otherModels += 1;
  }
  // O mais recente primeiro: é o que o operador quase sempre procura.
  compatible.sort((a, b) => String(b.uploadedAt ?? '').localeCompare(String(a.uploadedAt ?? '')));
  return { compatible, otherModels };
}

/** A versão que a ONT diz rodar, nos dois modelos de dados. */
export function currentFirmwareVersion(row) {
  const pick = (node) => {
    const value = node && typeof node === 'object' && '_value' in node ? node._value : node;
    return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  };
  return pick(row?.InternetGatewayDevice?.DeviceInfo?.SoftwareVersion)
    || pick(row?.Device?.DeviceInfo?.SoftwareVersion)
    || null;
}

/** Se o arquivo é a versão que a ONT já roda — reinstalar só a derrubaria à toa. */
export function isInstalledVersion(file, current) {
  return !vazio(file?.version) && !vazio(current) && igual(file.version, current);
}
