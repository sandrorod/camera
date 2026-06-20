// sessionStore.js
// Armazenamento em memória das sessões de transmissão. Substitui o EF Core/SQLite
// do backend original: como as sessões são efêmeras (vivem só enquanto o processo
// Node roda), não há necessidade de persistência em disco para este caso de uso.

const crypto = require('crypto');

const TOKEN_BYTE_LENGTH = 24;
const LIMITE_INATIVIDADE_MS = 5 * 60 * 1000; // 5 minutos, igual ao SessionCleanupService original

/** @type {Map<string, Sessao>} */
const sessoes = new Map();

/**
 * @typedef {Object} Sessao
 * @property {string} token
 * @property {string|null} broadcasterSocketId
 * @property {Set<string>} espectadores
 * @property {number} criadaEm
 * @property {number} ultimaAtividade
 * @property {number|null} expiraEm
 * @property {boolean} ativa
 */

function gerarTokenSeguro() {
    return crypto.randomBytes(TOKEN_BYTE_LENGTH)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function criarSessao(expiracaoMinutos) {
    const token = gerarTokenSeguro();
    const agora = Date.now();

    const sessao = {
        token,
        broadcasterSocketId: null,
        espectadores: new Set(),
        criadaEm: agora,
        ultimaAtividade: agora,
        expiraEm: expiracaoMinutos ? agora + expiracaoMinutos * 60 * 1000 : null,
        ativa: true
    };

    sessoes.set(token, sessao);
    return sessao;
}

function obterSessao(token) {
    return sessoes.get(token) || null;
}

function sessaoExpirada(sessao) {
    return Boolean(sessao.expiraEm && Date.now() > sessao.expiraEm);
}

function definirBroadcaster(token, socketId) {
    const sessao = obterSessao(token);
    if (!sessao) return null;
    sessao.broadcasterSocketId = socketId;
    sessao.ultimaAtividade = Date.now();
    return sessao;
}

function removerBroadcasterPorSocketId(socketId) {
    for (const sessao of sessoes.values()) {
        if (sessao.broadcasterSocketId === socketId) {
            sessao.broadcasterSocketId = null;
            return sessao;
        }
    }
    return null;
}

function adicionarEspectador(token, socketId) {
    const sessao = obterSessao(token);
    if (!sessao) return null;
    sessao.espectadores.add(socketId);
    sessao.ultimaAtividade = Date.now();
    return sessao;
}

function removerEspectadorPorSocketId(socketId) {
    for (const sessao of sessoes.values()) {
        if (sessao.espectadores.delete(socketId)) {
            return sessao;
        }
    }
    return null;
}

function atualizarAtividade(token) {
    const sessao = obterSessao(token);
    if (!sessao) return;
    sessao.ultimaAtividade = Date.now();
}

function encerrarSessao(token) {
    const sessao = obterSessao(token);
    if (!sessao) return;
    sessao.ativa = false;
    sessao.broadcasterSocketId = null;
}

/**
 * Remove sessões inativas (sem heartbeat) ou expiradas. Chamado periodicamente.
 * @returns {number} quantidade de sessões encerradas
 */
function encerrarSessoesInativas() {
    const agora = Date.now();
    let encerradas = 0;

    for (const sessao of sessoes.values()) {
        if (!sessao.ativa) continue;

        const inativa = agora - sessao.ultimaAtividade > LIMITE_INATIVIDADE_MS;
        if (inativa || sessaoExpirada(sessao)) {
            sessao.ativa = false;
            sessao.broadcasterSocketId = null;
            encerradas++;
        }
    }

    return encerradas;
}

module.exports = {
    criarSessao,
    obterSessao,
    sessaoExpirada,
    definirBroadcaster,
    removerBroadcasterPorSocketId,
    adicionarEspectador,
    removerEspectadorPorSocketId,
    atualizarAtividade,
    encerrarSessao,
    encerrarSessoesInativas
};
