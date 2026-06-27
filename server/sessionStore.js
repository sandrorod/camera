// sessionStore.js
// Armazenamento em memória das sessões de transmissão. Substitui o EF Core/SQLite
// do backend original: como as sessões são efêmeras (vivem só enquanto o processo
// Node roda), não há necessidade de persistência em disco para este caso de uso.
//
// Modelo: 1 sessão = 1 link compartilhável = N câmeras conectadas. O dashboard que
// criou a sessão assiste todas as câmeras simultaneamente; não há "espectador"
// avulso como na versão anterior (broadcaster único + N espectadores).

const crypto = require('crypto');

const TOKEN_BYTE_LENGTH = 24;
const LIMITE_INATIVIDADE_MS = 5 * 60 * 1000; // 5 minutos, igual ao SessionCleanupService original

/** @type {Map<string, Sessao>} */
const sessoes = new Map();

/**
 * @typedef {Object} Sessao
 * @property {string} token
 * @property {Map<string, { cameraId: string, socketId: string, conectadaEm: number }>} cameras - chave: cameraId
 * @property {Set<string>} dashboards
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
        cameras: new Map(),
        dashboards: new Set(),
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

function adicionarCamera(token, cameraId, socketId) {
    const sessao = obterSessao(token);
    if (!sessao) return null;
    sessao.cameras.set(cameraId, { cameraId, socketId, conectadaEm: Date.now() });
    sessao.ultimaAtividade = Date.now();
    return sessao;
}

function removerCameraPorSocketId(socketId) {
    for (const sessao of sessoes.values()) {
        for (const cam of sessao.cameras.values()) {
            if (cam.socketId === socketId) {
                sessao.cameras.delete(cam.cameraId);
                return sessao;
            }
        }
    }
    return null;
}

function listarCameras(token) {
    const sessao = obterSessao(token);
    if (!sessao) return [];
    return [...sessao.cameras.values()];
}

/**
 * Busca o socketId atual de uma câmera pelo seu cameraId persistente — usado para
 * resolver links de visualização individual, que sobrevivem a reconexões da câmera.
 */
function obterCameraPorCameraId(token, cameraId) {
    const sessao = obterSessao(token);
    if (!sessao) return null;
    return sessao.cameras.get(cameraId) || null;
}

function adicionarDashboard(token, socketId) {
    const sessao = obterSessao(token);
    if (!sessao) return null;
    sessao.dashboards.add(socketId);
    return sessao;
}

function removerDashboardPorSocketId(socketId) {
    for (const sessao of sessoes.values()) {
        if (sessao.dashboards.delete(socketId)) {
            return sessao;
        }
    }
    return null;
}

function listarDashboards(token) {
    const sessao = obterSessao(token);
    if (!sessao) return [];
    return [...sessao.dashboards];
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
    sessao.cameras.clear();
    sessao.dashboards.clear();
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
            sessao.cameras.clear();
            sessao.dashboards.clear();
            encerradas++;
        }
    }

    return encerradas;
}

module.exports = {
    criarSessao,
    obterSessao,
    sessaoExpirada,
    adicionarCamera,
    removerCameraPorSocketId,
    listarCameras,
    obterCameraPorCameraId,
    adicionarDashboard,
    removerDashboardPorSocketId,
    listarDashboards,
    atualizarAtividade,
    encerrarSessao,
    encerrarSessoesInativas
};
