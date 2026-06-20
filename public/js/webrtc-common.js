// webrtc-common.js
// Funcionalidades compartilhadas entre a página do transmissor (broadcaster.js)
// e a página do espectador (viewer.js): conexão Socket.io com reconexão automática
// e captura de câmera com fallback de resolução.

/**
 * Monta o array de servidores ICE (STUN + TURN) no formato esperado pelo RTCPeerConnection.
 */
function montarIceServers(iceConfig) {
    const iceServers = [];

    (iceConfig.stunServers || []).forEach((url) => {
        iceServers.push({ urls: url });
    });

    (iceConfig.turnServers || []).forEach((turn) => {
        if (!turn.urls) return;
        const entry = { urls: turn.urls };
        if (turn.username) entry.username = turn.username;
        if (turn.credential) entry.credential = turn.credential;
        iceServers.push(entry);
    });

    return iceServers;
}

/**
 * Busca a configuração ICE (STUN/TURN) do servidor de signaling.
 */
async function buscarIceConfig(serverUrl) {
    const resposta = await fetch(`${serverUrl}/api/ice-config`);
    return resposta.json();
}

/**
 * Cria uma conexão Socket.io com reconexão automática (backoff já embutido no
 * cliente Socket.io) e dispara o callback de mudança de estado.
 *
 * @param {string} serverUrl - URL do servidor de signaling (ex: https://api.exemplo.com).
 * @param {(estado: "conectando"|"conectado"|"reconectando"|"desconectado", socket: any) => void} onEstadoMudou
 */
function criarConexaoSocket(serverUrl, onEstadoMudou) {
    const socket = io(serverUrl, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30000
    });

    onEstadoMudou && onEstadoMudou('conectando', socket);

    socket.on('connect', () => onEstadoMudou && onEstadoMudou('conectado', socket));
    socket.io.on('reconnect_attempt', () => onEstadoMudou && onEstadoMudou('reconectando', socket));
    socket.io.on('reconnect', () => onEstadoMudou && onEstadoMudou('conectado', socket));
    socket.on('disconnect', () => onEstadoMudou && onEstadoMudou('desconectado', socket));

    return socket;
}

/**
 * Resolve a melhor combinação de resolução/fps suportada pela câmera do dispositivo,
 * tentando em ordem decrescente de qualidade até que getUserMedia tenha sucesso.
 */
async function obterMelhorStreamDisponivel(resolucoesEmOrdem, facingMode, fps) {
    let ultimoErro = null;

    for (const resolucao of resolucoesEmOrdem) {
        try {
            const constraints = {
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true
                },
                video: {
                    facingMode: { ideal: facingMode },
                    width: { ideal: resolucao.width },
                    height: { ideal: resolucao.height },
                    frameRate: { ideal: fps }
                }
            };

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            return { stream, resolucao };
        } catch (erro) {
            ultimoErro = erro;
            console.warn(`[Camera] Falha ao capturar em ${resolucao.width}x${resolucao.height}:`, erro.name);
        }
    }

    throw ultimoErro || new Error('Nenhuma resolução de câmera suportada foi encontrada.');
}

const RESOLUCOES_PADRAO = [
    { width: 3840, height: 2160 }, // 4K
    { width: 1920, height: 1080 }, // Full HD
    { width: 1280, height: 720 },  // HD
    { width: 640, height: 480 }    // SD
];

function resolucaoSelecionadaParaObjeto(valorSelect) {
    const [width, height] = valorSelect.split('x').map(Number);
    return { width, height };
}
