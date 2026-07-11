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
 * @property {Map<string, { cameraId: string, socketId: string, conectadaEm: number, vertical: boolean|null, silenciada: boolean }>} cameras - chave: cameraId
 * @property {Set<string>} dashboards
 * @property {Map<string, Set<string>>} observadoresPorCamera - cameraId -> socketIds assistindo via watch.html
 * @property {number} criadaEm
 * @property {number} ultimaAtividade
 * @property {number|null} expiraEm
 * @property {boolean} ativa
 * @property {string|null} cameraAtivaId - cameraId exibido no link de visualização único da sessão
 */

function gerarTokenSeguro() {
    return crypto.randomBytes(TOKEN_BYTE_LENGTH)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function criarSessao() {
    const token = gerarTokenSeguro();
    return criarSessaoComToken(token);
}

/**
 * Obtém a sessão em memória pelo token. Se não existir mas o token tiver um
 * formato válido (gerado por gerarTokenSeguro), cria uma sessão em memória sob
 * demanda — necessário para sessões persistidas no banco sobreviverem a um
 * restart do servidor: o registro em si (quais câmeras existem) está no
 * Supabase, mas o estado de conexão (sockets ativos) é sempre recriado aqui.
 */
function obterSessao(token) {
    let sessao = sessoes.get(token);
    if (!sessao && typeof token === 'string' && token.length > 0) {
        sessao = criarSessaoComToken(token);
    }
    return sessao || null;
}

function criarSessaoComToken(token) {
    const agora = Date.now();
    const sessao = {
        token,
        cameras: new Map(),
        dashboards: new Set(),
        observadoresPorCamera: new Map(),
        criadaEm: agora,
        ultimaAtividade: agora,
        expiraEm: null,
        ativa: true,
        cameraAtivaId: null
    };
    sessoes.set(token, sessao);
    return sessao;
}

function sessaoExpirada(sessao) {
    return Boolean(sessao.expiraEm && Date.now() > sessao.expiraEm);
}

function adicionarCamera(token, cameraId, socketId) {
    const sessao = obterSessao(token);
    if (!sessao) return null;
    const existente = sessao.cameras.get(cameraId);
    sessao.cameras.set(cameraId, {
        cameraId,
        socketId,
        conectadaEm: Date.now(),
        vertical: existente?.vertical ?? null,
        silenciada: existente?.silenciada ?? false
    });
    sessao.ultimaAtividade = Date.now();

    // Se não há câmera ativa selecionada para o link de visualização único,
    // a primeira a se conectar assume esse papel automaticamente.
    if (!sessao.cameraAtivaId) {
        sessao.cameraAtivaId = cameraId;
    }

    return sessao;
}

/**
 * Define qual câmera é exibida no link de visualização único da sessão
 * (watch.html?token=...). Retorna a sessão atualizada, ou null se a sessão ou
 * a câmera não existirem.
 */
function definirCameraAtiva(token, cameraId) {
    const sessao = obterSessao(token);
    if (!sessao || !sessao.cameras.has(cameraId)) return null;
    sessao.cameraAtivaId = cameraId;
    return sessao;
}

function obterCameraAtiva(token) {
    const sessao = obterSessao(token);
    if (!sessao || !sessao.cameraAtivaId) return null;
    return sessao.cameras.get(sessao.cameraAtivaId) || null;
}

function atualizarOrientacaoCamera(token, cameraId, vertical) {
    const sessao = obterSessao(token);
    const cam = sessao?.cameras.get(cameraId);
    if (!cam) return;
    cam.vertical = vertical;
}

/**
 * Alterna se o áudio da câmera é enviado aos observadores (link único e
 * individual). Retorna o novo estado, ou null se a câmera não existir.
 */
function alternarSilenciada(token, cameraId) {
    const sessao = obterSessao(token);
    const cam = sessao?.cameras.get(cameraId);
    if (!cam) return null;
    cam.silenciada = !cam.silenciada;
    return cam.silenciada;
}

function removerCameraPorSocketId(socketId) {
    for (const sessao of sessoes.values()) {
        for (const cam of sessao.cameras.values()) {
            if (cam.socketId === socketId) {
                sessao.cameras.delete(cam.cameraId);

                // Se a câmera removida era a ativa no link único, promove outra
                // câmera ainda conectada (se houver) para não deixar o link órfão.
                if (sessao.cameraAtivaId === cam.cameraId) {
                    const proxima = sessao.cameras.values().next().value;
                    sessao.cameraAtivaId = proxima ? proxima.cameraId : null;
                }

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

/**
 * Registra um observador (watch.html) assistindo a uma câmera específica.
 * Retorna a sessão e a contagem atualizada de observadores daquela câmera.
 */
function adicionarObservador(token, cameraId, socketId) {
    const sessao = obterSessao(token);
    if (!sessao) return null;

    if (!sessao.observadoresPorCamera.has(cameraId)) {
        sessao.observadoresPorCamera.set(cameraId, new Set());
    }
    sessao.observadoresPorCamera.get(cameraId).add(socketId);
    return sessao;
}

/**
 * Remove um observador pelo seu socketId, de qualquer câmera em que estivesse.
 * Retorna { sessao, cameraId } se encontrado, para notificar a contagem nova.
 */
function removerObservadorPorSocketId(socketId) {
    for (const sessao of sessoes.values()) {
        for (const [cameraId, observadores] of sessao.observadoresPorCamera.entries()) {
            if (observadores.delete(socketId)) {
                return { sessao, cameraId };
            }
        }
    }
    return null;
}

function contarObservadores(token, cameraId) {
    const sessao = obterSessao(token);
    if (!sessao) return 0;
    return sessao.observadoresPorCamera.get(cameraId)?.size || 0;
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
    sessao.observadoresPorCamera.clear();
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
            sessao.observadoresPorCamera.clear();
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
    definirCameraAtiva,
    obterCameraAtiva,
    atualizarOrientacaoCamera,
    alternarSilenciada,
    removerCameraPorSocketId,
    listarCameras,
    obterCameraPorCameraId,
    adicionarObservador,
    removerObservadorPorSocketId,
    contarObservadores,
    adicionarDashboard,
    removerDashboardPorSocketId,
    listarDashboards,
    atualizarAtividade,
    encerrarSessao,
    encerrarSessoesInativas
};
