// viewer.js
// Controla a página do espectador: conecta-se via SignalR, recebe o Offer SDP
// do transmissor, responde com Answer, troca ICE Candidates e exibe o vídeo
// recebido via WebRTC peer-to-peer. A página não exibe nenhum texto ou indicador
// visual — apenas o elemento <video> ocupando a tela inteira.

(function () {
    const config = window.__SECURITYCAM_CONFIG__;

    const elRemoteVideo = document.getElementById('remote-video');

    let connection = null;
    let peerConnection = null;
    let broadcasterConnectionId = null;

    /**
     * Cria a RTCPeerConnection do espectador. As tracks remotas recebidas são
     * conectadas diretamente ao elemento <video> para exibição em tempo real.
     */
    function criarPeerConnection() {
        const pc = new RTCPeerConnection({ iceServers: montarIceServers(config) });

        pc.ontrack = (event) => {
            if (elRemoteVideo.srcObject !== event.streams[0]) {
                elRemoteVideo.srcObject = event.streams[0];
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
        };

        return pc;
    }

    async function configurarSignalR() {
        connection = await criarConexaoSignalR('/hubs/camera', (estado, conexaoAtual) => {
            if (estado === 'conectado') {
                entrarNaSessao(conexaoAtual);
            }
        });

        connection.on('BroadcasterOnline', () => {
            entrarNaSessao();
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
            if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
            }
        });

        connection.on('Erro', (mensagem) => {
            console.error('[Viewer] Erro do servidor:', mensagem);
        });
    }

    async function entrarNaSessao(conexaoAtual) {
        const conn = conexaoAtual || connection;
        await conn.invoke('EntrarComoEspectador', config.token);
    }

    configurarSignalR();
})();
