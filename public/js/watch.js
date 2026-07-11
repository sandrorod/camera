// watch.js
// Controla a página de visualização: conecta-se via Socket.io como observador de
// uma câmera (identificada por cameraId, estável entre reconexões), recebe o
// Offer SDP dela, responde com Answer, troca ICE Candidates e exibe o vídeo
// recebido via WebRTC em tela cheia, sem nenhum outro elemento de UI.
// Se a URL não trouxer cameraId (link único de visualização, compartilhado por
// todas as câmeras da sessão), o servidor decide qual câmera mostrar — a marcada
// como "Selecionada" no dashboard — e pode trocá-la a qualquer momento via
// 'cameraAtivaAtualizada', sem que o espectador precise trocar de link.

(function () {
    const config = window.__SECURITYCAM_CONFIG__;

    const elRemoteVideo = document.getElementById('remote-video');
    const elConnectionOverlay = document.getElementById('connection-overlay');

    let connection = null;
    let peerConnection = null;
    let cameraSocketId = null;
    let cameraIdAtual = config.cameraId || null;
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

        connection.on('orientacaoCameraAtualizada', ({ cameraId, vertical, invertido }) => {
            if (cameraId !== cameraIdAtual) return;
            elRemoteVideo.classList.toggle('remote-video-vertical', vertical);
            elRemoteVideo.classList.toggle('remote-video-invertido', !!invertido);
        });

        connection.on('cameraDesconectada', ({ cameraId }) => {
            if (cameraId !== cameraIdAtual) return;
            if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
            }
            elRemoteVideo.srcObject = null;
            definirOverlay('A câmera foi desconectada.');
        });

        // Só se aplica ao link único (sem cameraId fixo na URL): o servidor avisa
        // quando a câmera selecionada no dashboard muda, e a página troca de
        // stream automaticamente, sem precisar recarregar.
        connection.on('cameraAtivaAtualizada', ({ cameraId }) => {
            if (config.cameraId || cameraId === cameraIdAtual) return;

            cameraIdAtual = cameraId;
            if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
            }
            elRemoteVideo.srcObject = null;

            if (!cameraId) {
                definirOverlay('Nenhuma câmera conectada no momento.');
            } else {
                definirOverlay('Conectando à câmera...');
            }
        });

        connection.on('erro', (mensagem) => {
            console.error('[Watch] Erro do servidor:', mensagem);
            definirOverlay(mensagem);
        });
    }

    function entrarComoObservador(conexaoAtual) {
        const conn = conexaoAtual || connection;
        conn.emit('entrarComoObservador', { token: config.token, cameraId: config.cameraId || undefined });
    }

    configurarSocket();
})();
