// camera.js
// Controla a página da câmera: captura de câmera/microfone, preview local,
// criação de uma RTCPeerConnection com o dashboard que está assistindo, e
// signaling via Socket.io.

(function () {
    const config = window.__SECURITYCAM_CONFIG__;

    /**
     * cameraId persistente: gerado uma vez e salvo no localStorage deste dispositivo/
     * navegador. Sobrevive a reloads e reconexões, permitindo que o link de
     * visualização individual (watch.html) continue válido mesmo que o socketId mude.
     * É por sessão (token), já que o mesmo celular pode usar links diferentes.
     */
    function obterCameraId(token) {
        const chave = `securitycam_camera_id_${token}`;
        let cameraId = localStorage.getItem(chave);
        if (!cameraId) {
            cameraId = crypto.randomUUID();
            localStorage.setItem(chave, cameraId);
        }
        return cameraId;
    }
    const cameraId = obterCameraId(config.token);

    const elLocalPreview = document.getElementById('local-preview');
    const elConnectionOverlay = document.getElementById('connection-overlay');
    const elRecIndicator = document.getElementById('rec-indicator');
    const elBtnStart = document.getElementById('btn-start');
    const elBtnStop = document.getElementById('btn-stop');
    const elBtnSwitchCamera = document.getElementById('btn-switch-camera');
    const elSelectResolution = document.getElementById('select-resolution');
    const elSelectFps = document.getElementById('select-fps');
    const elQualityLabel = document.getElementById('quality-label');
    const elFpsLabel = document.getElementById('fps-label');
    const elStatusMessage = document.getElementById('status-message');

    /** @type {MediaStream|null} */
    let localStream = null;

    /** Mapa de RTCPeerConnection por socketId do dashboard. Hoje só há 1 dashboard por sessão, mas o mapa suporta múltiplos. */
    const peerConnections = new Map();

    let iceConfig = { stunServers: [], turnServers: [] };
    let facingModeAtual = 'environment'; // câmera traseira por padrão
    let transmitindo = false;
    let connection = null;
    let heartbeatIntervalId = null;
    let fpsObservadoIntervalId = null;

    /** @type {WakeLockSentinel|null} */
    let wakeLock = null;

    /**
     * Mantém a tela do celular ligada enquanto a transmissão estiver ativa,
     * evitando que o sistema apague a tela e interrompa a captura de câmera
     * por inatividade. Precisa ser readquirido ao voltar de background, pois
     * o navegador libera o lock automaticamente quando a aba perde foco.
     */
    async function adquirirWakeLock() {
        if (!('wakeLock' in navigator)) {
            console.warn('[WakeLock] API não suportada neste navegador.');
            definirStatus('Aviso: este navegador não suporta manter a tela acesa automaticamente.');
            return;
        }

        try {
            wakeLock = await navigator.wakeLock.request('screen');
            console.info('[WakeLock] Adquirido com sucesso.');
            wakeLock.addEventListener('release', () => {
                console.info('[WakeLock] Liberado pelo sistema.');
            });
        } catch (erro) {
            console.warn('[WakeLock] Falha ao adquirir:', erro.name, erro.message);
            definirStatus(`Aviso: não foi possível manter a tela acesa (${erro.name}). Ative manualmente em Configurações > Tela > Tempo limite.`);
        }
    }

    function liberarWakeLock() {
        if (wakeLock) {
            wakeLock.release().catch(() => {});
            wakeLock = null;
        }
    }

    /**
     * Alguns fabricantes (Samsung, Xiaomi etc) liberam o Wake Lock mesmo com a
     * aba em foco, fora do ciclo de vida documentado pela API. Verifica
     * periodicamente e readquire se necessário, como camada extra de defesa
     * além do listener de visibilitychange.
     */
    setInterval(() => {
        if (transmitindo && !wakeLock) {
            adquirirWakeLock();
        }
    }, 15000);

    document.addEventListener('visibilitychange', () => {
        if (transmitindo && document.visibilityState === 'visible' && !wakeLock) {
            adquirirWakeLock();
        }
    });

    function definirStatus(mensagem) {
        elStatusMessage.textContent = mensagem;
    }

    function atualizarIndicadorQualidade(resolucao, fps) {
        elQualityLabel.textContent = `${resolucao.width}x${resolucao.height}`;
        elFpsLabel.textContent = `${fps} fps`;
    }

    /**
     * Solicita permissão de câmera/microfone e inicia o preview local,
     * tentando a maior resolução suportada a partir da seleção do usuário.
     */
    async function iniciarCaptura() {
        const resolucaoSelecionada = resolucaoSelecionadaParaObjeto(elSelectResolution.value);
        const fpsSelecionado = Number(elSelectFps.value);

        const indiceInicial = RESOLUCOES_PADRAO.findIndex(
            (r) => r.width === resolucaoSelecionada.width && r.height === resolucaoSelecionada.height
        );
        const ordemTentativas = indiceInicial >= 0
            ? RESOLUCOES_PADRAO.slice(indiceInicial)
            : RESOLUCOES_PADRAO;

        elConnectionOverlay.classList.remove('hidden');
        elConnectionOverlay.querySelector('p').textContent = 'Solicitando permissão da câmera...';

        const { stream, resolucao } = await obterMelhorStreamDisponivel(ordemTentativas, facingModeAtual, fpsSelecionado);

        localStream = stream;
        elLocalPreview.srcObject = stream;
        elConnectionOverlay.classList.add('hidden');

        const trackSettings = stream.getVideoTracks()[0]?.getSettings() ?? {};
        const fpsReal = Math.round(trackSettings.frameRate || fpsSelecionado);
        atualizarIndicadorQualidade(
            { width: trackSettings.width || resolucao.width, height: trackSettings.height || resolucao.height },
            fpsReal
        );

        notificarOrientacaoSeMudou(trackSettings.width, trackSettings.height);
        monitorarFpsReal(stream);
    }

    /**
     * A proporção real da track de vídeo (não a resolução nominal selecionada)
     * já reflete a orientação física do celular — sensores móveis ajustam
     * width/height automaticamente ao girar o aparelho. Avisa o dashboard e
     * observadores sempre que a orientação detectada mudar, para que ajustem
     * o aspect-ratio do vídeo exibido (retrato vs paisagem) em vez de cortar
     * ou distorcer a imagem.
     */
    let orientacaoAtual = null;
    function notificarOrientacaoSeMudou(width, height) {
        if (!width || !height) return;
        const vertical = height > width;
        if (orientacaoAtual === vertical) return;
        orientacaoAtual = vertical;

        if (connection && connection.connected) {
            connection.emit('orientacaoAtualizada', { token: config.token, vertical });
        }
    }

    function monitorarFpsReal(stream) {
        if (fpsObservadoIntervalId) clearInterval(fpsObservadoIntervalId);

        fpsObservadoIntervalId = setInterval(() => {
            const track = stream.getVideoTracks()[0];
            if (!track) return;
            const settings = track.getSettings();
            if (settings.width && settings.height) {
                elQualityLabel.textContent = `${settings.width}x${settings.height}`;
            }
            if (settings.frameRate) {
                elFpsLabel.textContent = `${Math.round(settings.frameRate)} fps`;
            }
            notificarOrientacaoSeMudou(settings.width, settings.height);
        }, 3000);
    }

    /**
     * O WebRTC aplica por padrão um teto de bitrate conservador (~1-2.5 Mbps)
     * independente da resolução da track, deixando a imagem comprimida em
     * Full HD/4K. Porém setar um teto muito acima do upload real do celular
     * (ex: 12 Mbps em 4G/Wi-Fi doméstico, que raramente sustenta isso) faz o
     * encoder mirar um bitrate inalcançável, causando congestionamento, perda
     * de pacotes e travamentos — pior que a compressão original. Os valores
     * abaixo são um meio-termo: acima do teto padrão para melhorar a nitidez,
     * mas dentro do que uploads móveis/residenciais comuns sustentam. O
     * controle de congestionamento do WebRTC (GCC) ainda reduz dinamicamente
     * abaixo deste teto se a rede não suportar.
     */
    function bitrateMaximoParaResolucao(largura, altura) {
        const pixels = largura * altura;
        if (pixels >= 3840 * 2160) return 4_000_000;  // 4K
        if (pixels >= 1920 * 1080) return 2_500_000;  // Full HD
        if (pixels >= 1280 * 720) return 1_500_000;   // HD
        return 800_000;                                // SD
    }

    async function aplicarBitrateMaximo(pc) {
        const trackSettings = localStream?.getVideoTracks()[0]?.getSettings() ?? {};
        const maxBitrate = bitrateMaximoParaResolucao(trackSettings.width || 0, trackSettings.height || 0);

        const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (!sender) return;

        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = maxBitrate;
        // Prioriza manter o frame rate fluido (sem travar) em vez de preservar
        // resolução quando a rede/CPU não acompanha o bitrate configurado.
        params.degradationPreference = 'maintain-framerate';

        try {
            await sender.setParameters(params);
        } catch (erro) {
            console.warn('[WebRTC] Não foi possível definir o bitrate máximo:', erro);
        }
    }

    /**
     * Cria uma nova RTCPeerConnection dedicada a um dashboard específico,
     * adiciona as tracks locais e envia o Offer SDP via Socket.io.
     */
    async function criarPeerConnectionParaDashboard(dashboardSocketId) {
        const pc = new RTCPeerConnection({ iceServers: montarIceServers(iceConfig) });
        peerConnections.set(dashboardSocketId, pc);

        localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
        await aplicarBitrateMaximo(pc);

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                connection.emit('enviarIceCandidate', {
                    targetSocketId: dashboardSocketId,
                    candidate: event.candidate
                });
            }
        };

        pc.onconnectionstatechange = () => {
            console.info(`[WebRTC] Estado da conexão com dashboard ${dashboardSocketId}: ${pc.connectionState}`);
            if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                peerConnections.delete(dashboardSocketId);
            }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        connection.emit('enviarOffer', { targetSocketId: dashboardSocketId, sdpOffer: offer });

        return pc;
    }

    async function configurarSocket() {
        iceConfig = await buscarIceConfig(config.serverUrl);

        connection = criarConexaoSocket(config.serverUrl, (estado, conexaoAtual) => {
            if (estado === 'reconectando') {
                definirStatus('Conexão perdida. Tentando reconectar automaticamente...');
            } else if (estado === 'conectado' && transmitindo) {
                definirStatus('Reconectado. Retomando transmissão...');
                conexaoAtual.emit('entrarComoCamera', { token: config.token, cameraId });
            }
        });

        connection.on('cameraConfirmada', () => {
            definirStatus('Transmissão ativa. Aguardando conexão com o dashboard...');

            // Garante que a orientação inicial seja enviada agora que a conexão existe
            // (na primeira captura, a conexão ainda não tinha sido criada).
            const settings = localStream?.getVideoTracks()[0]?.getSettings() ?? {};
            if (settings.width && settings.height) {
                orientacaoAtual = null;
                notificarOrientacaoSeMudou(settings.width, settings.height);
            }
        });

        connection.on('novoEspectador', async (dashboardSocketId) => {
            try {
                await criarPeerConnectionParaDashboard(dashboardSocketId);
            } catch (erro) {
                console.error('[WebRTC] Erro ao conectar com o dashboard:', erro);
            }
        });

        connection.on('receberAnswer', async ({ senderSocketId, sdpAnswer }) => {
            const pc = peerConnections.get(senderSocketId);
            if (!pc) return;
            await pc.setRemoteDescription(new RTCSessionDescription(sdpAnswer));
        });

        connection.on('receberIceCandidate', async ({ senderSocketId, candidate }) => {
            const pc = peerConnections.get(senderSocketId);
            if (!pc) return;
            try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (erro) {
                console.error('[WebRTC] Erro ao adicionar ICE candidate:', erro);
            }
        });

        connection.on('erro', (mensagem) => {
            definirStatus(`Erro: ${mensagem}`);
        });
    }

    async function iniciarTransmissao() {
        elBtnStart.disabled = true;

        try {
            if (!localStream) {
                await iniciarCaptura();
            }

            if (!connection) {
                await configurarSocket();
            }

            connection.emit('entrarComoCamera', { token: config.token, cameraId });

            transmitindo = true;
            elRecIndicator.classList.remove('hidden');
            elBtnStart.classList.add('hidden');
            elBtnStop.classList.remove('hidden');
            definirStatus('Transmissão iniciada. A câmera já aparece no dashboard.');

            iniciarHeartbeat();
            await adquirirWakeLock();
        } catch (erro) {
            console.error('[Câmera] Erro ao iniciar transmissão:', erro);
            definirStatus(`Não foi possível acessar a câmera: ${erro.message}`);
            elBtnStart.disabled = false;
        }
    }

    function iniciarHeartbeat() {
        if (heartbeatIntervalId) clearInterval(heartbeatIntervalId);
        heartbeatIntervalId = setInterval(() => {
            if (connection && connection.connected) {
                connection.emit('heartbeat', config.token);
            }
        }, 30000);
    }

    async function pararTransmissao(notificarServidor = true) {
        transmitindo = false;
        liberarWakeLock();

        if (heartbeatIntervalId) {
            clearInterval(heartbeatIntervalId);
            heartbeatIntervalId = null;
        }

        peerConnections.forEach((pc) => pc.close());
        peerConnections.clear();

        if (notificarServidor && connection) {
            connection.emit('pararTransmissao', config.token);
        }

        if (localStream) {
            localStream.getTracks().forEach((track) => track.stop());
            localStream = null;
        }

        elRecIndicator.classList.add('hidden');
        elBtnStart.classList.remove('hidden');
        elBtnStart.disabled = false;
        elBtnStop.classList.add('hidden');
        definirStatus('Transmissão encerrada.');
    }

    async function alternarCamera() {
        facingModeAtual = facingModeAtual === 'environment' ? 'user' : 'environment';

        if (!localStream) return;

        const streamAntigo = localStream;
        streamAntigo.getTracks().forEach((track) => track.stop());

        const resolucaoSelecionada = resolucaoSelecionadaParaObjeto(elSelectResolution.value);
        const fpsSelecionado = Number(elSelectFps.value);
        const indiceInicial = RESOLUCOES_PADRAO.findIndex(
            (r) => r.width === resolucaoSelecionada.width && r.height === resolucaoSelecionada.height
        );
        const ordemTentativas = indiceInicial >= 0 ? RESOLUCOES_PADRAO.slice(indiceInicial) : RESOLUCOES_PADRAO;

        const { stream } = await obterMelhorStreamDisponivel(ordemTentativas, facingModeAtual, fpsSelecionado);
        localStream = stream;
        elLocalPreview.srcObject = stream;
        monitorarFpsReal(stream);

        const novaTrack = stream.getVideoTracks()[0];
        peerConnections.forEach(async (pc) => {
            const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
            if (sender) await sender.replaceTrack(novaTrack);
            await aplicarBitrateMaximo(pc);
        });
    }

    elBtnStart.addEventListener('click', iniciarTransmissao);
    elBtnStop.addEventListener('click', () => pararTransmissao(true));
    elBtnSwitchCamera.addEventListener('click', alternarCamera);

    window.addEventListener('beforeunload', () => {
        if (transmitindo) {
            pararTransmissao(true);
        }
    });
})();
