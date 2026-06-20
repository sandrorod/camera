// viewer.js
// Controla a página do espectador: conecta-se via SignalR, recebe o Offer SDP
// do transmissor, responde com Answer, troca ICE Candidates e exibe o vídeo
// recebido via WebRTC peer-to-peer.

(function () {
    const config = window.__SECURITYCAM_CONFIG__;

    const elRemoteVideo = document.getElementById('remote-video');
    const elViewerOverlay = document.getElementById('viewer-overlay');
    const elViewerOverlayText = document.getElementById('viewer-overlay-text');
    const elConnectionStatus = document.getElementById('connection-status');
    const elStreamQualityTag = document.getElementById('stream-quality-tag');

    let connection = null;
    let peerConnection = null;
    let broadcasterConnectionId = null;
    let qualidadeIntervalId = null;

    function definirStatusConexao(texto, classe) {
        elConnectionStatus.textContent = texto;
        elConnectionStatus.className = `badge badge-status ${classe}`;
    }

    function mostrarOverlay(texto) {
        elViewerOverlayText.textContent = texto;
        elViewerOverlay.classList.remove('hidden');
    }

    function ocultarOverlay() {
        elViewerOverlay.classList.add('hidden');
    }

    /**
     * Cria a RTCPeerConnection do espectador. As tracks remotas recebidas são
     * conectadas diretamente ao elemento <video> para exibição em tempo real.
     */
    function criarPeerConnection() {
        const pc = new RTCPeerConnection({ iceServers: montarIceServers(config) });

        pc.ontrack = (event) => {
            if (elRemoteVideo.srcObject !== event.streams[0]) {
                elRemoteVideo.srcObject = event.streams[0];
                ocultarOverlay();
                monitorarQualidadeRecebida(event.streams[0]);
            }
        };

        pc.onicecandidate = (event) => {
            if (event.candidate && broadcasterConnectionId) {
                connection.invoke('EnviarIceCandidate', broadcasterConnectionId, JSON.stringify(event.candidate))
                    .catch((erro) => console.error('[WebRTC] Erro ao enviar ICE candidate:', erro));
            }
        };

        pc.onconnectionstatechange = () => {
            console.info('[WebRTC] Estado da conexão com o transmissor:', pc.connectionState);

            if (pc.connectionState === 'connected') {
                definirStatusConexao('Conectado', 'badge-connected');
            } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                definirStatusConexao('Reconectando...', 'badge-connecting');
                mostrarOverlay('Conexão perdida. Tentando reconectar...');
            }
        };

        return pc;
    }

    function monitorarQualidadeRecebida(stream) {
        if (qualidadeIntervalId) clearInterval(qualidadeIntervalId);

        qualidadeIntervalId = setInterval(() => {
            const track = stream.getVideoTracks()[0];
            if (!track) return;
            const settings = track.getSettings();
            if (settings.width && settings.height) {
                elStreamQualityTag.textContent = `${settings.width}x${settings.height}`;
            }
        }, 3000);
    }

    async function configurarSignalR() {
        connection = await criarConexaoSignalR('/hubs/camera', (estado) => {
            if (estado === 'reconectando') {
                definirStatusConexao('Reconectando...', 'badge-connecting');
                mostrarOverlay('Conexão com o servidor perdida. Tentando reconectar...');
            } else if (estado === 'conectado') {
                entrarNaSessao();
            } else if (estado === 'desconectado') {
                definirStatusConexao('Desconectado', 'badge-error');
            }
        });

        connection.on('BroadcasterOffline', () => {
            definirStatusConexao('Aguardando transmissor', 'badge-connecting');
            mostrarOverlay('O transmissor ainda não está online. Aguardando...');
        });

        connection.on('BroadcasterOnline', () => {
            entrarNaSessao();
        });

        connection.on('EspectadorConfirmado', () => {
            definirStatusConexao('Conectando ao vídeo...', 'badge-connecting');
        });

        connection.on('ReceberOffer', async (broadcasterId, sdpOfferJson) => {
            broadcasterConnectionId = broadcasterId;

            if (peerConnection) {
                peerConnection.close();
            }
            peerConnection = criarPeerConnection();

            const offer = JSON.parse(sdpOfferJson);
            await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);

            await connection.invoke('EnviarAnswer', broadcasterId, JSON.stringify(answer));
        });

        connection.on('ReceberIceCandidate', async (_senderId, candidateJson) => {
            if (!peerConnection) return;
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(JSON.parse(candidateJson)));
            } catch (erro) {
                console.error('[WebRTC] Erro ao adicionar ICE candidate:', erro);
            }
        });

        connection.on('TransmissaoEncerrada', () => {
            definirStatusConexao('Transmissão encerrada', 'badge-error');
            mostrarOverlay('A transmissão foi encerrada pelo transmissor.');
            if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
            }
        });

        connection.on('Erro', (mensagem) => {
            definirStatusConexao('Erro', 'badge-error');
            mostrarOverlay(mensagem);
        });
    }

    async function entrarNaSessao() {
        definirStatusConexao('Conectando...', 'badge-connecting');
        await connection.invoke('EntrarComoEspectador', config.token, null);
    }

    configurarSignalR();
})();
