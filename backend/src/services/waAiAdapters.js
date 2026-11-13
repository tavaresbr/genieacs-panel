/**
 * Os provedores de IA que o painel sabe falar. Por dentro a conversa tem um
 * formato só, o da OpenAI (`messages` com `system|user|assistant|tool`,
 * `tool_calls`); cada adaptador converte de e para a API do provedor e
 * devolve `{content, toolCalls, message}`.
 */

export const AI_PROVIDER_OPENAI = 'openai-compatible';
export const AI_PROVIDER_ANTHROPIC = 'anthropic';

export const AI_PROVIDERS = {
  [AI_PROVIDER_OPENAI]: {
    id: AI_PROVIDER_OPENAI,
    defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-4.5-flash'
  },
  [AI_PROVIDER_ANTHROPIC]: {
    id: AI_PROVIDER_ANTHROPIC,
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5-5'
  }
};

export const isAiProvider = (id) => Object.hasOwn(AI_PROVIDERS, id);
export const aiProviderOrDefault = (id) => (isAiProvider(id) ? id : AI_PROVIDER_OPENAI);

const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_FOLGA_PENSAMENTO = 1024;
/** Modelos com `effort` e pensamento adaptativo; os mais antigos recusam `effort`. */
const ANTHROPIC_MODELO_ATUAL = /^claude-(?:(?:fable|mythos|opus|sonnet|haiku)-5|opus-4-[678]|sonnet-4-6)/;

const parseArgs = (raw) => {
  try {
    return typeof raw === 'string' ? (raw.trim() ? JSON.parse(raw) : {}) : (raw || {});
  } catch {
    return {};
  }
};

/**
 * O conteúdo de uma mensagem como texto, para quem só lê texto (a API
 * compatível com a OpenAI): partes de texto viram linhas; imagem e PDF ficam de fora.
 */
const achatar = (mensagem, separador = '\n') => {
  if (!Array.isArray(mensagem?.content)) return mensagem;
  const texto = mensagem.content.map((p) => (typeof p === 'string' ? p : (p?.type === undefined || p?.type === 'text' ? p?.text ?? '' : ''))).filter(Boolean).join(separador);
  return { ...mensagem, content: texto };
};

const openai = {
  path: '/chat/completions',
  buildRequest({ apiKey, model, messages: bruto, tools, maxTokens, hostname = '' }) {
    const messages = (bruto || []).map((m) => achatar(m, m.role === 'system' ? '\n\n' : '\n'));
    // A OpenAI de verdade (GPT-5, série "o") recusa `max_tokens` e `temperature`
    // diferente do padrão; a z.ai e os compatíveis seguem com os dois.
    const oficial = hostname === 'api.openai.com';
    return {
      headers: { Authorization: `Bearer ${apiKey}` },
      body: {
        model,
        messages,
        ...(oficial ? { max_completion_tokens: maxTokens } : { temperature: 0.3, max_tokens: maxTokens }),
        ...(tools?.length ? { tools, tool_choice: 'auto' } : {})
      }
    };
  },
  /** Códigos que a z.ai usa para "sem saldo". */
  isNoBalance: ({ codigo, mensagem }) =>
    codigo === '1113' || /balance|saldo|余额|resource package/i.test(mensagem),
  parse(data) {
    const message = data?.choices?.[0]?.message;
    if (!message || typeof message !== 'object') return null;
    const toolCalls = [];
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const name = call?.function?.name;
      if (!name) continue;
      toolCalls.push({
        id: String(call.id || `call_${toolCalls.length}`),
        name: String(name),
        arguments: parseArgs(call.function.arguments)
      });
    }
    const content = typeof message.content === 'string' ? message.content.trim() : null;
    const uso = data?.usage;
    return {
      content: content || null,
      toolCalls,
      message,
      usage: uso ? {
        input: Number(uso.prompt_tokens) || 0,
        output: Number(uso.completion_tokens) || 0,
        cacheRead: Number(uso.prompt_tokens_details?.cached_tokens) || 0,
        cacheWrite: 0
      } : null
    };
  }
};

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('\n');
  return '';
};

const MIDIA_SUPORTADA = {
  image: /^image\/(?:jpeg|png|gif|webp)$/i,
  document: /^application\/pdf$/i
};

/**
 * O conteúdo de um turno do cliente como blocos da Anthropic: texto, imagem e
 * PDF (`{type:'image'|'document', mediaType, data}` em base64). Mídia de tipo
 * que a API não lê é descartada.
 */
function paraBlocos(content) {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content.trim() }] : [];
  const blocos = [];
  for (const p of Array.isArray(content) ? content : []) {
    if (typeof p === 'string') {
      if (p.trim()) blocos.push({ type: 'text', text: p.trim() });
    } else if (p?.type === undefined || p.type === 'text') {
      if (String(p?.text ?? '').trim()) blocos.push({ type: 'text', text: String(p.text).trim() });
    } else if ((p.type === 'image' || p.type === 'document') && p.data && MIDIA_SUPORTADA[p.type].test(String(p.mediaType))) {
      blocos.push({ type: p.type, source: { type: 'base64', media_type: p.mediaType, data: p.data } });
    }
  }
  return blocos;
}

/** Anthropic exige alternar user/assistant: turnos seguidos do mesmo papel viram um. */
function pushTurn(turns, role, blocks) {
  if (!blocks.length) return;
  const last = turns[turns.length - 1];
  if (last && last.role === role) last.content.push(...blocks);
  else turns.push({ role, content: [...blocks] });
}

/**
 * Mensagens no formato OpenAI → `{system, messages}` da Anthropic.
 *
 * Sem `tools` na chamada (a última volta do laço tira as ferramentas), blocos
 * `tool_use`/`tool_result` no histórico seriam recusados: viram texto.
 */
export function toAnthropicMessages(messages, { comFerramentas = true } = {}) {
  const system = [];
  const systemBlocks = [];
  const turns = [];
  for (const m of messages || []) {
    if (m.role === 'system') {
      // Partes `{text, cache}`: o fim de uma parte com `cache` vira ponto de cache do prompt.
      for (const p of Array.isArray(m.content) ? m.content : [m.content]) {
        const t = String(typeof p === 'string' ? p : p?.text ?? '').trim();
        if (!t) continue;
        system.push(t);
        systemBlocks.push({ text: t, cache: Boolean(p?.cache) });
      }
    } else if (m.role === 'assistant') {
      const blocks = [];
      const t = textOf(m.content).trim();
      if (t) blocks.push({ type: 'text', text: t });
      for (const call of m.tool_calls || []) {
        if (comFerramentas) {
          blocks.push({
            type: 'tool_use',
            id: String(call.id),
            name: String(call.function?.name ?? ''),
            input: parseArgs(call.function?.arguments)
          });
        } else {
          blocks.push({ type: 'text', text: `[ferramenta ${call.function?.name ?? ''} chamada]` });
        }
      }
      pushTurn(turns, 'assistant', blocks);
    } else if (m.role === 'tool') {
      pushTurn(turns, 'user', [comFerramentas
        ? { type: 'tool_result', tool_use_id: String(m.tool_call_id), content: textOf(m.content) }
        : { type: 'text', text: `[resultado da ferramenta] ${textOf(m.content)}` }]);
    } else {
      pushTurn(turns, 'user', paraBlocos(m.content));
    }
  }
  // A conversa tem de começar por um turno do usuário.
  if (turns.length && turns[0].role !== 'user') turns.unshift({ role: 'user', content: [{ type: 'text', text: '.' }] });
  return { system: system.join('\n\n'), systemBlocks, messages: turns };
}

const anthropic = {
  path: '/v1/messages',
  buildRequest({ apiKey, model, messages, tools, maxTokens, workspaceId = '' }) {
    const { system, systemBlocks, messages: turns } = toAnthropicMessages(messages, { comFerramentas: Boolean(tools?.length) });
    // Com pontos de cache, o sistema vai em blocos (o que vem até um ponto, ferramentas incluídas, é lido do cache nas próximas chamadas); sem, a string de sempre.
    const sistema = systemBlocks.some((b) => b.cache)
      ? systemBlocks.map((b) => ({ type: 'text', text: b.text, ...(b.cache ? { cache_control: { type: 'ephemeral' } } : {}) }))
      : system;
    // Nos modelos atuais o pensamento vem ligado e gasta o mesmo `max_tokens`
    // da resposta: esforço baixo e folga, para a resposta não sair vazia ou
    // cortada. `temperature` nem é enviada: os modelos da família 5 recusam
    // valor diferente do padrão (400).
    const atual = ANTHROPIC_MODELO_ATUAL.test(model);
    return {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        // Chave que não pertence a um workspace pede o id dele neste cabeçalho.
        ...(workspaceId ? { 'anthropic-workspace-id': workspaceId } : {})
      },
      body: {
        model,
        max_tokens: atual ? maxTokens + ANTHROPIC_FOLGA_PENSAMENTO : maxTokens,
        ...(atual ? { output_config: { effort: 'low' } } : {}),
        ...(sistema.length ? { system: sistema } : {}),
        messages: turns,
        ...(tools?.length
          ? {
              tools: tools.map((t) => ({
                name: t.function.name,
                description: t.function.description ?? '',
                input_schema: t.function.parameters ?? { type: 'object', properties: {} }
              })),
              tool_choice: { type: 'auto' }
            }
          : {})
      }
    };
  },
  isNoBalance: ({ mensagem }) => /credit balance|billing/i.test(mensagem),
  parse(data) {
    if (!data || !Array.isArray(data.content)) return null;
    const texts = [];
    const toolCalls = [];
    for (const block of data.content) {
      if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      else if (block?.type === 'tool_use' && block.name) {
        toolCalls.push({
          id: String(block.id || `call_${toolCalls.length}`),
          name: String(block.name),
          arguments: block.input && typeof block.input === 'object' ? block.input : {}
        });
      }
    }
    const content = texts.join('\n').trim();
    // `message` no formato interno (OpenAI), como o orquestrador espera.
    const message = {
      role: 'assistant',
      content: content || null,
      ...(toolCalls.length
        ? {
            tool_calls: toolCalls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.arguments) }
            }))
          }
        : {})
    };
    const uso = data.usage;
    return {
      content: content || null,
      toolCalls,
      message,
      usage: uso ? {
        // `input_tokens` não inclui o que veio do cache nem o que foi gravado nele.
        input: Number(uso.input_tokens) || 0,
        output: Number(uso.output_tokens) || 0,
        cacheRead: Number(uso.cache_read_input_tokens) || 0,
        cacheWrite: Number(uso.cache_creation_input_tokens) || 0
      } : null
    };
  }
};

export const AI_ADAPTERS = { [AI_PROVIDER_OPENAI]: openai, [AI_PROVIDER_ANTHROPIC]: anthropic };
