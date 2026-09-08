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
    let cameraIdAtual = config.cameraId || null;
    let iceConfig = { stunServers: [], turnServers: [] };

    /**
     * PCs mantidas vivas por cameraId, mesmo quando a câmera deixa de ser a
     * exibida no momento (deselecionada, ou trocada por outra) — sem isso,
     * toda troca fechava e recriava a conexão do zero, obrigando um novo
     * handshake ICE completo (coleta de candidates STUN/TURN + teste de
     * conectividade), que sozinho já leva vários segundos. Reselecionar uma
     * câmera cuja PC ainda está viva aqui reaproveita o stream na hora, sem
     * esperar handshake nenhum.
     */
    const peerConnectionsPorCamera = new Map();

    /** Soma o ângulo automático (câmera invertida em paisagem) com a rotação
     *  manual (botão girar do dashboard) num só transform no vídeo. */
    function aplicarTransformVideo() {
        const anguloAuto = Number(elRemoteVideo.dataset.anguloAuto || '0');
        const anguloManual = Number(elRemoteVideo.dataset.anguloManual || '0');
        const total = (anguloAuto + anguloManual) % 360;
        elRemoteVideo.style.transform = total ? `rotate(${total}deg)` : '';
    }

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

    /** Exibe o stream de uma câmera já conectada e pronta, sem nenhum handshake. */
    function exibirStream(stream) {
        if (elRemoteVideo.srcObject !== stream) {
            elRemoteVideo.srcObject = stream;
        }
        definirOverlay(null);
        tentarReproduzirComAudio();
    }

    /**
     * @param {string} cameraId
     * @param {string} targetSocketId - socketId da câmera dona desta PC, fixado
     * no momento da criação (nunca lido de uma variável externa mutável) — sem
     * isso, um ICE candidate gerado de forma assíncrona por uma PC antiga
     * (mesmo após close(), o navegador pode disparar onicecandidate um pouco
     * depois) era enviado para a câmera NOVA (cameraSocketId global já
     * atualizado), quebrando a negociação ICE da conexão nova e prendendo o
     * link em "Conectando à câmera..." ao trocar de câmera ativa.
     */
    function criarPeerConnection(cameraId, targetSocketId) {
        const pc = new RTCPeerConnection({ iceServers: montarIceServers(iceConfig) });
        const entrada = { pc, stream: null, targetSocketId };
        peerConnectionsPorCamera.set(cameraId, entrada);

        pc.ontrack = (event) => {
            entrada.stream = event.streams[0];
            // Só atualiza a tela se esta ainda for a câmera atualmente
            // selecionada — a PC pode ter recebido a track em background
            // (mantida viva após uma troca) sem estar em exibição no momento.
            if (cameraId === cameraIdAtual) {
                exibirStream(entrada.stream);
            }
        };

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                connection.emit('enviarIceCandidate', {
                    targetSocketId,
                    candidate: event.candidate
                });
            }
        };

        pc.onconnectionstatechange = () => {
            console.info(`[WebRTC] Estado da conexão com a câmera ${cameraId}:`, pc.connectionState);
            if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                peerConnectionsPorCamera.delete(cameraId);
            }
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

        // O servidor identifica a câmera de origem só pelo socketId (Offer não
        // carrega cameraId) — como cada RTCPeerConnection agora é mantida viva
        // por cameraId (ver peerConnectionsPorCamera), guardamos qual cameraId
        // corresponde a cada socketId de câmera visto, pra rotear o Offer/ICE
        // recebido pra entrada certa do Map em vez de uma única PC global.
        const cameraIdPorSocketId = new Map();

        connection.on('receberOffer', async ({ senderSocketId, sdpOffer }) => {
            // Descobre a qual câmera este socketId pertence: é o cameraId que
            // acabamos de marcar como atual (cameraAtivaAtualizada roda antes
            // do servidor pedir o Offer) ou, numa renegociação de uma câmera
            // já conhecida, o que já estava associado a esse socketId.
            const cameraId = cameraIdPorSocketId.get(senderSocketId) ?? cameraIdAtual;
            cameraIdPorSocketId.set(senderSocketId, cameraId);

            const existente = peerConnectionsPorCamera.get(cameraId);
            if (existente) {
                existente.pc.close();
            }
            const pc = criarPeerConnection(cameraId, senderSocketId);

            await pc.setRemoteDescription(new RTCSessionDescription(sdpOffer));

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            connection.emit('enviarAnswer', { targetSocketId: senderSocketId, sdpAnswer: answer });
        });

        connection.on('receberIceCandidate', async ({ senderSocketId, candidate }) => {
            const cameraId = cameraIdPorSocketId.get(senderSocketId);
            const entrada = cameraId ? peerConnectionsPorCamera.get(cameraId) : null;
            // Ignora candidates de uma PC que não é (mais) a registrada para
            // este socketId — podem chegar atrasados após uma renegociação e
            // quebrariam a conexão nova se aplicados nela.
            if (!entrada || entrada.targetSocketId !== senderSocketId) return;
            try {
                await entrada.pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (erro) {
                console.error('[WebRTC] Erro ao adicionar ICE candidate:', erro);
            }
        });

        connection.on('orientacaoCameraAtualizada', ({ cameraId, vertical, invertido }) => {
            if (cameraId !== cameraIdAtual) return;
            elRemoteVideo.classList.toggle('remote-video-vertical', vertical);
            // invertido só vem true para celular/tablet em paisagem — ver
            // ehDispositivoMovel em camera.js (webcam de PC não precisa disso).
            elRemoteVideo.dataset.anguloAuto = invertido ? '180' : '0';
            aplicarTransformVideo();
        });

        // Rotação manual (botão "girar" no dashboard) — combinada com o ângulo
        // automático acima, já que ambos escrevem na mesma propriedade
        // transform e não podem se sobrescrever.
        connection.on('rotacaoCameraAtualizada', ({ cameraId, rotacaoManual }) => {
            if (cameraId !== cameraIdAtual) return;
            elRemoteVideo.dataset.anguloManual = String(rotacaoManual);
            aplicarTransformVideo();
        });

        connection.on('cameraDesconectada', ({ cameraId }) => {
            const entrada = peerConnectionsPorCamera.get(cameraId);
            if (entrada) {
                entrada.pc.close();
                peerConnectionsPorCamera.delete(cameraId);
            }
            if (cameraId !== cameraIdAtual) return;
            elRemoteVideo.srcObject = null;
            definirOverlay('A câmera foi desconectada.');
        });

        // Só se aplica ao link único (sem cameraId fixo na URL): o servidor avisa
        // quando a câmera selecionada no dashboard muda, e a página troca de
        // stream automaticamente, sem precisar recarregar.
        connection.on('cameraAtivaAtualizada', ({ cameraId }) => {
            if (config.cameraId || cameraId === cameraIdAtual) return;

            cameraIdAtual = cameraId;

            // Deliberadamente NÃO fecha a PC da câmera anterior — ela continua
            // recebendo vídeo em background, pronta para reaparecer na hora se
            // o usuário voltar a selecioná-la (evita refazer o handshake ICE
            // completo, que sozinho leva vários segundos).
            const entrada = cameraId ? peerConnectionsPorCamera.get(cameraId) : null;
            if (entrada?.stream) {
                // Já temos uma conexão viva e com vídeo para esta câmera —
                // exibe na hora, sem esperar nenhum Offer/handshake novo.
                exibirStream(entrada.stream);
                return;
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
