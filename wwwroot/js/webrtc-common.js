// webrtc-common.js
// Funcionalidades compartilhadas entre a página do transmissor (broadcaster.js)
// e a página do espectador (viewer.js): conexão SignalR com reconexão automática
// e montagem da configuração ICE (STUN/TURN) usada pelo RTCPeerConnection.

/**
 * Monta o array de servidores ICE (STUN + TURN) no formato esperado pelo RTCPeerConnection,
 * a partir da configuração injetada pelo servidor em window.__SECURITYCAM_CONFIG__.
 */
function montarIceServers(config) {
    const iceServers = [];

    (config.stunServers || []).forEach((url) => {
        iceServers.push({ urls: url });
    });

    (config.turnServers || []).forEach((turn) => {
        if (!turn.urls) return;
        const entry = { urls: turn.urls };
        if (turn.username) entry.username = turn.username;
        if (turn.credential) entry.credential = turn.credential;
        iceServers.push(entry);
    });

    return iceServers;
}

/**
 * Cria e inicia uma conexão SignalR com reconexão automática (backoff progressivo)
 * e retorna a instância da conexão já com handlers de ciclo de vida configurados.
 *
 * O callback onEstadoMudou recebe a própria conexão como segundo argumento, pois
 * o evento "conectado" pode disparar antes desta função retornar — código chamador
 * que dependa da conexão dentro do callback deve usar esse argumento, não uma
 * variável externa atribuída ao valor de retorno (que ainda seria undefined/null
 * no momento do primeiro disparo).
 *
 * @param {string} hubUrl - URL do hub SignalR (ex: "/hubs/camera").
 * @param {(estado: "conectando"|"conectado"|"reconectando"|"desconectado", connection: any) => void} onEstadoMudou
 */
async function criarConexaoSignalR(hubUrl, onEstadoMudou) {
    const connection = new signalR.HubConnectionBuilder()
        .withUrl(hubUrl)
        .withAutomaticReconnect([0, 1000, 2000, 5000, 10000, 15000, 30000])
        .configureLogging(signalR.LogLevel.Warning)
        .build();

    connection.onreconnecting(() => {
        console.warn('[SignalR] Conexão perdida. Tentando reconectar...');
        onEstadoMudou && onEstadoMudou('reconectando', connection);
    });

    connection.onreconnected(() => {
        console.info('[SignalR] Reconectado com sucesso.');
        onEstadoMudou && onEstadoMudou('conectado', connection);
    });

    connection.onclose(() => {
        console.error('[SignalR] Conexão encerrada definitivamente.');
        onEstadoMudou && onEstadoMudou('desconectado', connection);
    });

    onEstadoMudou && onEstadoMudou('conectando', connection);

    await iniciarComRetentativa(connection, onEstadoMudou);

    return connection;
}

/**
 * Tenta iniciar a conexão SignalR, repetindo com backoff caso o servidor esteja
 * indisponível no primeiro carregamento da página (ex: reinício do servidor).
 */
async function iniciarComRetentativa(connection, onEstadoMudou, tentativa = 0) {
    try {
        await connection.start();
        onEstadoMudou && onEstadoMudou('conectado', connection);
    } catch (erro) {
        console.error('[SignalR] Falha ao conectar:', erro);
        onEstadoMudou && onEstadoMudou('reconectando', connection);
        const delay = Math.min(1000 * Math.pow(2, tentativa), 30000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        await iniciarComRetentativa(connection, onEstadoMudou, tentativa + 1);
    }
}

/**
 * Resolve a melhor combinação de resolução/fps suportada pela câmera do dispositivo,
 * tentando em ordem decrescente de qualidade até que getUserMedia tenha sucesso.
 *
 * @param {{width: number, height: number}[]} resolucoesEmOrdem
 * @param {string} facingMode - "environment" (traseira) ou "user" (frontal)
 * @param {number} fps
 */
async function obterMelhorStreamDisponivel(resolucoesEmOrdem, facingMode, fps) {
    let ultimoErro = null;

    for (const resolucao of resolucoesEmOrdem) {
        try {
            const constraints = {
                audio: false,
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
