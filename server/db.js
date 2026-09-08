// db.js
// Persistência no Supabase do que precisa sobreviver a um restart do servidor
// e ser visto igual em qualquer dispositivo — diferente do estado em memória
// do sessionStore.js (sockets, peer connections — efêmero por natureza).
// Três responsabilidades: registrar câmeras conectadas em cada sessão (tabela
// 'cameras', usada pelas rotas legadas de múltiplas sessões), e guardar dois
// tokens fixos e independentes na tabela 'app_settings' (ver
// obterOuCriarToken/regenerarToken):
//   - link_unico_token: identifica a SESSÃO (a "sala" onde câmeras, dashboard
//     e observadores se encontram) e também é o token do link de VISUALIZAÇÃO
//     (watch.html) — nunca muda, para sempre.
//   - link_camera_token: token separado que autoriza camera.html a entrar
//     nessa mesma sessão fixa — pode ser regenerado a qualquer momento (ex:
//     revogar o acesso de quem já tem o link) sem afetar o link de
//     visualização, que continua o mesmo de sempre.

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

if (!supabase) {
    console.warn('[db] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não configurados — persistência de câmeras desativada.');
}

const CHAVE_LINK_UNICO = 'link_unico_token';
const CHAVE_LINK_CAMERA = 'link_camera_token';
const TOKEN_BYTE_LENGTH = 24;

function gerarTokenSeguro() {
    return crypto.randomBytes(TOKEN_BYTE_LENGTH)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * Retorna o valor salvo em app_settings para `chave`, criando-o com um token
 * novo na primeira chamada e reaproveitando para sempre depois.
 *
 * Se duas requisições concorrentes chegarem simultaneamente na primeira vez
 * (nenhum valor ainda salvo), a chave primária em 'key' rejeita o segundo
 * insert com um erro de unique violation (23505) — nesse caso a requisição
 * perdedora não trata isso como falha, apenas lê de volta o valor que a
 * vencedora efetivamente salvou, garantindo que ambas retornem o mesmo token.
 */
async function obterOuCriarToken(chave) {
    if (!supabase) return null;

    const { data: existente, error: erroLeitura } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', chave)
        .maybeSingle();

    if (erroLeitura) {
        console.error(`[db] Erro ao ler o token '${chave}':`, erroLeitura.message);
        return null;
    }
    if (existente) return existente.value;

    const novoToken = gerarTokenSeguro();
    const { error: erroInsercao } = await supabase
        .from('app_settings')
        .insert({ key: chave, value: novoToken });

    if (!erroInsercao) return novoToken;

    // Código 23505 = violação de unique constraint (chave primária): outra
    // requisição venceu a corrida e já inseriu o token antes desta. Não é um
    // erro real — lê de volta o valor que efetivamente ficou salvo.
    if (erroInsercao.code !== '23505') {
        console.error(`[db] Erro ao criar o token '${chave}':`, erroInsercao.message);
        return null;
    }

    const { data: salvoPorOutraRequisicao } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', chave)
        .maybeSingle();

    return salvoPorOutraRequisicao?.value || null;
}

/** Gera um token novo para `chave` e sobrescreve o valor salvo — usado para
 *  regenerar o link de câmera sem afetar o link de visualização (chave
 *  diferente). Retorna o novo token, ou null em caso de erro. */
async function regenerarToken(chave) {
    if (!supabase) return null;

    const novoToken = gerarTokenSeguro();
    const { error } = await supabase
        .from('app_settings')
        .upsert({ key: chave, value: novoToken, updated_at: new Date().toISOString() }, { onConflict: 'key' });

    if (error) {
        console.error(`[db] Erro ao regenerar o token '${chave}':`, error.message);
        return null;
    }
    return novoToken;
}

const obterOuCriarTokenLinkUnico = () => obterOuCriarToken(CHAVE_LINK_UNICO);
const obterOuCriarTokenLinkCamera = () => obterOuCriarToken(CHAVE_LINK_CAMERA);
const regenerarTokenLinkCamera = () => regenerarToken(CHAVE_LINK_CAMERA);

async function registrarCamera(sessionToken, cameraId, nome) {
    if (!supabase) return;
    const { error } = await supabase
        .from('cameras')
        .upsert({ session_token: sessionToken, camera_id: cameraId, nome }, { onConflict: 'session_token,camera_id' });

    if (error) console.error('[db] Erro ao registrar câmera:', error.message);
}

async function listarCamerasPorSessao(sessionToken) {
    if (!supabase) return [];
    const { data, error } = await supabase
        .from('cameras')
        .select('camera_id, nome, created_at')
        .eq('session_token', sessionToken);

    if (error) {
        console.error('[db] Erro ao listar câmeras da sessão:', error.message);
        return [];
    }
    return data;
}

async function listarTokensDeSessao() {
    if (!supabase) return [];
    const { data, error } = await supabase
        .from('cameras')
        .select('session_token')
        .order('created_at', { ascending: false });

    if (error) {
        console.error('[db] Erro ao listar tokens de sessão:', error.message);
        return [];
    }
    return [...new Set(data.map((row) => row.session_token))];
}

async function removerCamerasPorSessao(sessionToken) {
    if (!supabase) return;
    const { error } = await supabase.from('cameras').delete().eq('session_token', sessionToken);
    if (error) console.error('[db] Erro ao remover câmeras da sessão:', error.message);
}

module.exports = {
    registrarCamera,
    listarCamerasPorSessao,
    listarTokensDeSessao,
    removerCamerasPorSessao,
    obterOuCriarTokenLinkUnico,
    obterOuCriarTokenLinkCamera,
    regenerarTokenLinkCamera
};
