// viewer.js
// Controla a página do espectador: conecta-se via Socket.io, recebe o Offer SDP
// do transmissor, responde com Answer, troca ICE Candidates e exibe o vídeo
// recebido via WebRTC peer-to-peer. A página não exibe nenhum texto ou indicador
// visual — apenas o elemento <video> ocupando a tela inteira.

(function () {
    const config = window.__SECURITYCAM_CONFIG__;

    const elRemoteVideo = document.getElementById('remote-video');

    let connection = null;
    let peerConnection = null;
    let broadcasterSocketId = null;
    let iceConfig = { stunServers: [], turnServers: [] };

    /**
     * Cria a RTCPeerConnection do espectador. As tracks remotas recebidas são
     * conectadas diretamente ao elemento <video> para exibição em tempo real.
     */
    function criarPeerConnection() {
        const pc = new RTCPeerConnection({ iceServers: montarIceServers(iceConfig) });

        pc.ontrack = (event) => {
            if (elRemoteVideo.srcObject !== event.streams[0]) {
                elRemoteVideo.srcObject = event.streams[0];
            }
        };

        pc.onicecandidate = (event) => {
            if (event.candidate && broadcasterSocketId) {
                connection.emit('enviarIceCandidate', {
                    targetSocketId: broadcasterSocketId,
                    candidate: event.candidate
                });
            }
        };

        pc.onconnectionstatechange = () => {
            console.info('[WebRTC] Estado da conexão com o transmissor:', pc.connectionState);
        };

        return pc;
    }

    async function configurarSocket() {
        iceConfig = await buscarIceConfig(config.serverUrl);

        connection = criarConexaoSocket(config.serverUrl, (estado, conexaoAtual) => {
            if (estado === 'conectado') {
                entrarNaSessao(conexaoAtual);
            }
        });

        connection.on('broadcasterOnline', () => {
            entrarNaSessao(connection);
        });

        connection.on('receberOffer', async ({ senderSocketId, sdpOffer }) => {
            broadcasterSocketId = senderSocketId;

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

        connection.on('transmissaoEncerrada', () => {
            if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
            }
        });

        connection.on('erro', (mensagem) => {
            console.error('[Viewer] Erro do servidor:', mensagem);
        });
    }

    async function entrarNaSessao(conexaoAtual) {
        const conn = conexaoAtual || connection;
        conn.emit('entrarComoEspectador', config.token);
    }

    configurarSocket();
})();
