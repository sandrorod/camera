// broadcaster.js
// Controla a página do transmissor: captura de câmera/microfone, preview local,
// criação de uma RTCPeerConnection por espectador conectado, e signaling via SignalR.

(function () {
    const config = window.__SECURITYCAM_CONFIG__;

    const elLocalPreview = document.getElementById('local-preview');
    const elConnectionOverlay = document.getElementById('connection-overlay');
    const elRecIndicator = document.getElementById('rec-indicator');
    const elBtnStart = document.getElementById('btn-start');
    const elBtnStop = document.getElementById('btn-stop');
    const elBtnSwitchCamera = document.getElementById('btn-switch-camera');
    const elBtnShare = document.getElementById('btn-share');
    const elShareBox = document.getElementById('share-box');
    const elShareLinkInput = document.getElementById('share-link-input');
    const elBtnCopyLink = document.getElementById('btn-copy-link');
    const elSelectResolution = document.getElementById('select-resolution');
    const elSelectFps = document.getElementById('select-fps');
    const elQualityLabel = document.getElementById('quality-label');
    const elFpsLabel = document.getElementById('fps-label');
    const elViewerCountValue = document.getElementById('viewer-count-value');
    const elStatusMessage = document.getElementById('status-message');

    /** @type {MediaStream|null} */
    let localStream = null;

    /** Mapa de RTCPeerConnection por connectionId de espectador. */
    const peerConnections = new Map();

    let facingModeAtual = 'environment'; // câmera traseira por padrão
    let transmitindo = false;
    let connection = null;
    let heartbeatIntervalId = null;
    let fpsObservadoIntervalId = null;

    function definirStatus(mensagem) {
        elStatusMessage.textContent = mensagem;
    }

    function atualizarIndicadorQualidade(resolucao, fps) {
        elQualityLabel.textContent = `${resolucao.width}x${resolucao.height}`;
        elFpsLabel.textContent = `${fps} fps`;
    }

    function atualizarContagemEspectadores(quantidade) {
        elViewerCountValue.textContent = String(quantidade);
    }

    /**
     * Solicita permissão de câmera/microfone e inicia o preview local,
     * tentando a maior resolução suportada a partir da seleção do usuário.
     */
    async function iniciarCaptura() {
        const resolucaoSelecionada = resolucaoSelecionadaParaObjeto(elSelectResolution.value);
        const fpsSelecionado = Number(elSelectFps.value);

        // Tenta a resolução selecionada primeiro; se falhar, cai para as menores.
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

        monitorarFpsReal(stream);
    }

    /**
     * Monitora periodicamente o FPS real entregue pela track de vídeo,
     * atualizando o indicador de qualidade exibido na tela.
     */
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
        }, 3000);
    }

    /**
     * Cria uma nova RTCPeerConnection dedicada a um espectador específico,
     * adiciona as tracks locais e envia o Offer SDP via SignalR.
     */
    async function criarPeerConnectionParaEspectador(viewerConnectionId) {
        const pc = new RTCPeerConnection({ iceServers: montarIceServers(config) });
        peerConnections.set(viewerConnectionId, pc);

        localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                connection.invoke('EnviarIceCandidate', viewerConnectionId, JSON.stringify(event.candidate))
                    .catch((erro) => console.error('[WebRTC] Erro ao enviar ICE candidate:', erro));
            }
        };

        pc.onconnectionstatechange = () => {
            console.info(`[WebRTC] Estado da conexão com espectador ${viewerConnectionId}: ${pc.connectionState}`);
            if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                peerConnections.delete(viewerConnectionId);
            }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        await connection.invoke('EnviarOffer', viewerConnectionId, JSON.stringify(offer));

        return pc;
    }

    async function configurarSignalR() {
        connection = await criarConexaoSignalR('/hubs/camera', (estado, conexaoAtual) => {
            if (estado === 'reconectando') {
                definirStatus('Conexão perdida. Tentando reconectar automaticamente...');
            } else if (estado === 'conectado' && transmitindo) {
                definirStatus('Reconectado. Retomando transmissão...');
                (conexaoAtual || connection).invoke('EntrarComoBroadcaster', config.token).catch(console.error);
            }
        });

        connection.on('BroadcasterConfirmado', () => {
            definirStatus('Transmissão ativa. Aguardando espectadores...');
        });

        connection.on('NovoEspectador', async (viewerConnectionId) => {
            try {
                await criarPeerConnectionParaEspectador(viewerConnectionId);
            } catch (erro) {
                console.error('[WebRTC] Erro ao conectar com espectador:', erro);
            }
        });

        connection.on('ReceberAnswer', async (viewerConnectionId, sdpAnswerJson) => {
            const pc = peerConnections.get(viewerConnectionId);
            if (!pc) return;
            const answer = JSON.parse(sdpAnswerJson);
            await pc.setRemoteDescription(new RTCSessionDescription(answer));
        });

        connection.on('ReceberIceCandidate', async (viewerConnectionId, candidateJson) => {
            const pc = peerConnections.get(viewerConnectionId);
            if (!pc) return;
            try {
                await pc.addIceCandidate(new RTCIceCandidate(JSON.parse(candidateJson)));
            } catch (erro) {
                console.error('[WebRTC] Erro ao adicionar ICE candidate:', erro);
            }
        });

        connection.on('AtualizarContagemEspectadores', (quantidade) => {
            atualizarContagemEspectadores(quantidade);
        });

        connection.on('TransmissaoEncerrada', () => {
            pararTransmissao(false);
        });

        connection.on('Erro', (mensagem) => {
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
                await configurarSignalR();
            }

            await connection.invoke('EntrarComoBroadcaster', config.token);

            transmitindo = true;
            elRecIndicator.classList.remove('hidden');
            elBtnStart.classList.add('hidden');
            elBtnStop.classList.remove('hidden');
            elBtnShare.classList.remove('hidden');
            definirStatus('Transmissão iniciada. Compartilhe o link para que outras pessoas assistam.');

            iniciarHeartbeat();
        } catch (erro) {
            console.error('[Broadcaster] Erro ao iniciar transmissão:', erro);
            definirStatus(`Não foi possível acessar a câmera: ${erro.message}`);
            elBtnStart.disabled = false;
        }
    }

    function iniciarHeartbeat() {
        if (heartbeatIntervalId) clearInterval(heartbeatIntervalId);
        heartbeatIntervalId = setInterval(() => {
            if (connection && connection.state === signalR.HubConnectionState.Connected) {
                connection.invoke('Heartbeat', config.token).catch(console.error);
            }
        }, 30000);
    }

    async function pararTransmissao(notificarServidor = true) {
        transmitindo = false;

        if (heartbeatIntervalId) {
            clearInterval(heartbeatIntervalId);
            heartbeatIntervalId = null;
        }

        peerConnections.forEach((pc) => pc.close());
        peerConnections.clear();

        if (notificarServidor && connection) {
            try {
                await connection.invoke('PararTransmissao', config.token);
            } catch (erro) {
                console.error('[Broadcaster] Erro ao notificar encerramento:', erro);
            }
        }

        if (localStream) {
            localStream.getTracks().forEach((track) => track.stop());
            localStream = null;
        }

        elRecIndicator.classList.add('hidden');
        elBtnStart.classList.remove('hidden');
        elBtnStart.disabled = false;
        elBtnStop.classList.add('hidden');
        elBtnShare.classList.add('hidden');
        elShareBox.classList.add('hidden');
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
        peerConnections.forEach((pc) => {
            const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
            if (sender) sender.replaceTrack(novaTrack);
        });
    }

    function copiarLink() {
        elShareLinkInput.select();
        navigator.clipboard?.writeText(elShareLinkInput.value).then(() => {
            definirStatus('Link copiado para a área de transferência.');
        }).catch(() => {
            document.execCommand('copy');
        });
    }

    function abrirCompartilhamento() {
        elShareBox.classList.toggle('hidden');

        if (navigator.share) {
            navigator.share({
                title: 'Assista à transmissão em tempo real',
                url: config.viewerShareUrl
            }).catch(() => {
                // usuário cancelou o compartilhamento nativo; o link continua visível na share-box
            });
        }
    }

    elBtnStart.addEventListener('click', iniciarTransmissao);
    elBtnStop.addEventListener('click', () => pararTransmissao(true));
    elBtnSwitchCamera.addEventListener('click', alternarCamera);
    elBtnShare.addEventListener('click', abrirCompartilhamento);
    elBtnCopyLink.addEventListener('click', copiarLink);

    window.addEventListener('beforeunload', () => {
        if (transmitindo) {
            pararTransmissao(true);
        }
    });
})();
