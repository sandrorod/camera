// watch.js
// Controla a página de visualização individual: conecta-se via Socket.io como
// observador de UMA câmera específica (identificada por cameraId, estável entre
// reconexões), recebe o Offer SDP dela, responde com Answer, troca ICE Candidates
// e exibe o vídeo recebido via WebRTC em tela cheia, sem nenhum outro elemento de UI.

(function () {
    const config = window.__SECURITYCAM_CONFIG__;

    const elRemoteVideo = document.getElementById('remote-video');
    const elConnectionOverlay = document.getElementById('connection-overlay');

    let connection = null;
    let peerConnection = null;
    let cameraSocketId = null;
    let iceConfig = { stunServers: [], turnServers: [] };

    function definirOverlay(mensagem) {
        if (mensagem) {
            elConnectionOverlay.querySelector('p').textContent = mensagem;
            elConnectionOverlay.classList.remove('hidden');
        } else {
            elConnectionOverlay.classList.add('hidden');
        }
    }

    /**
     * Navegadores bloqueiam autoplay de vídeo com áudio sem interação prévia
     * do usuário. Se isso acontecer, reproduz mutado e ativa o som no primeiro
     * toque na tela — assim o vídeo nunca trava esperando uma ação explícita.
     */
    function tentarReproduzirComAudio() {
        elRemoteVideo.muted = false;
        elRemoteVideo.play().catch(() => {
            elRemoteVideo.muted = true;
            elRemoteVideo.play().catch(() => {});

            const ativarSom = () => {
                elRemoteVideo.muted = false;
                document.removeEventListener('click', ativarSom);
                document.removeEventListener('touchend', ativarSom);
            };
            document.addEventListener('click', ativarSom, { once: true });
            document.addEventListener('touchend', ativarSom, { once: true });
        });
    }

    function criarPeerConnection() {
        const pc = new RTCPeerConnection({ iceServers: montarIceServers(iceConfig) });

        pc.ontrack = (event) => {
            if (elRemoteVideo.srcObject !== event.streams[0]) {
                elRemoteVideo.srcObject = event.streams[0];
                definirOverlay(null);
                tentarReproduzirComAudio();
            }
        };

        pc.onicecandidate = (event) => {
            if (event.candidate && cameraSocketId) {
                connection.emit('enviarIceCandidate', {
                    targetSocketId: cameraSocketId,
                    candidate: event.candidate
                });
            }
        };

        pc.onconnectionstatechange = () => {
            console.info('[WebRTC] Estado da conexão com a câmera:', pc.connectionState);
        };

        return pc;
    }

    async function configurarSocket() {
        iceConfig = await buscarIceConfig(config.serverUrl);

        connection = criarConexaoSocket(config.serverUrl, (estado, conexaoAtual) => {
            if (estado === 'conectado') {
                entrarComoObservador(conexaoAtual);
            } else if (estado === 'reconectando') {
                definirOverlay('Conexão perdida. Tentando reconectar...');
            }
        });

        connection.on('receberOffer', async ({ senderSocketId, sdpOffer }) => {
            cameraSocketId = senderSocketId;

            if (peerConnection) {
                peerConnection.close();
            }
            peerConnection = criarPeerConnection();

            await peerConnection.setRemoteDescription(new RTCSessionDescription(sdpOffer));

            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);

            connection.emit('enviarAnswer', { targetSocketId: senderSocketId, sdpAnswer: answer });
        });

        connection.on('receberIceCandidate', async ({ candidate }) => {
            if (!peerConnection) return;
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (erro) {
                console.error('[WebRTC] Erro ao adicionar ICE candidate:', erro);
            }
        });

        connection.on('orientacaoCameraAtualizada', ({ cameraId, vertical }) => {
            if (cameraId !== config.cameraId) return;
            elRemoteVideo.classList.toggle('remote-video-vertical', vertical);
        });

        connection.on('cameraDesconectada', ({ cameraId }) => {
            if (cameraId !== config.cameraId) return;
            if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
            }
            elRemoteVideo.srcObject = null;
            definirOverlay('A câmera foi desconectada.');
        });

        connection.on('erro', (mensagem) => {
            console.error('[Watch] Erro do servidor:', mensagem);
            definirOverlay(mensagem);
        });
    }

    function entrarComoObservador(conexaoAtual) {
        const conn = conexaoAtual || connection;
        conn.emit('entrarComoObservador', { token: config.token, cameraId: config.cameraId });
    }

    configurarSocket();
})();
