// dashboard.js
// Controla o dashboard: mantém uma lista de sessões (links gerados), persistida no
// banco (Supabase, via API do servidor) para que apareça em qualquer dispositivo,
// não só no navegador que gerou o link. Para cada sessão, abre uma conexão
// Socket.io dedicada, cria uma RTCPeerConnection por câmera conectada, e renderiza
// um card com vídeo para cada uma em um grid próprio daquela sessão. Cards e
// seções aparecem/desaparecem automaticamente conforme câmeras/sessões mudam.

(function () {
    const serverUrl = window.__SECURITYCAM_CONFIG__.serverUrl;

    const elSessionsList = document.getElementById('sessions-list');
    const elEmptyState = document.getElementById('empty-state');
    const templateSession = document.getElementById('template-session');
    const templateCameraCard = document.getElementById('template-camera-card');

    /** @type {Map<string, SessaoUI>} token -> estado da sessão no dashboard */
    const sessoes = new Map();

    /**
     * @typedef {Object} SessaoUI
     * @property {string} token
     * @property {any} connection - socket.io
     * @property {Map<string, RTCPeerConnection>} peerConnections
     * @property {Map<string, HTMLVideoElement>} videoElements
     * @property {Map<string, string>} cameraIds - socketId -> cameraId persistente
     * @property {Map<string, HTMLElement>} camerasPorId - cameraId -> elemento .camera-card
     * @property {HTMLElement} elCard - elemento .session-card
     */

    async function carregarTokensSalvos() {
        try {
            const resposta = await fetch(`${serverUrl}/api/sessions`);
            const dados = await resposta.json();
            return dados.tokens || [];
        } catch (erro) {
            console.error('[Dashboard] Erro ao carregar sessões salvas:', erro);
            return [];
        }
    }

    function atualizarEmptyState() {
        elEmptyState.classList.toggle('hidden', sessoes.size > 0);
    }

    function linkCameraPara(token) {
        return `${window.location.origin}/camera.html?token=${encodeURIComponent(token)}`;
    }

    function linkVisualizacaoPara(token, cameraId) {
        return `${window.location.origin}/watch.html?token=${encodeURIComponent(token)}&camera=${encodeURIComponent(cameraId)}`;
    }

    function copiarTexto(texto) {
        navigator.clipboard?.writeText(texto).catch(() => {
            const temp = document.createElement('textarea');
            temp.value = texto;
            document.body.appendChild(temp);
            temp.select();
            document.execCommand('copy');
            temp.remove();
        });
    }

    function criarSecaoSessao(token) {
        const fragment = templateSession.content.cloneNode(true);
        const elCard = fragment.querySelector('.session-card');
        const elLinkInput = fragment.querySelector('.session-link-input');
        const elBtnCopiar = fragment.querySelector('.btn-copy-session-link');
        const elBtnRemover = fragment.querySelector('.btn-remove-session');

        elLinkInput.value = linkCameraPara(token);
        elBtnCopiar.addEventListener('click', () => copiarTexto(elLinkInput.value));
        elBtnRemover.addEventListener('click', () => removerSessao(token));

        elSessionsList.appendChild(fragment);
        return elSessionsList.lastElementChild;
    }

    function atualizarSessionEmptyState(sessaoUI) {
        const temCameras = sessaoUI.videoElements.size > 0;
        sessaoUI.elCard.querySelector('.session-empty-state').classList.toggle('hidden', temCameras);
    }

    function criarCardCamera(sessaoUI, cameraSocketId, cameraId) {
        if (sessaoUI.videoElements.has(cameraSocketId)) {
            return sessaoUI.videoElements.get(cameraSocketId);
        }

        const fragment = templateCameraCard.content.cloneNode(true);
        const elCard = fragment.querySelector('.camera-card');
        const video = fragment.querySelector('video');
        const elBtnCopiarCamera = fragment.querySelector('.btn-copy-camera-link');

        if (cameraId) {
            elBtnCopiarCamera.addEventListener('click', () => copiarTexto(linkVisualizacaoPara(sessaoUI.token, cameraId)));
        } else {
            elBtnCopiarCamera.disabled = true;
        }

        sessaoUI.elCard.querySelector('.cameras-grid').appendChild(fragment);
        elCard.dataset.socketId = cameraSocketId;

        sessaoUI.videoElements.set(cameraSocketId, video);
        if (cameraId) sessaoUI.camerasPorId.set(cameraId, elCard);
        atualizarSessionEmptyState(sessaoUI);
        return video;
    }

    function removerCardCamera(sessaoUI, cameraSocketId) {
        const video = sessaoUI.videoElements.get(cameraSocketId);
        if (!video) return;

        video.srcObject = null;
        video.closest('.camera-card')?.remove();
        sessaoUI.videoElements.delete(cameraSocketId);

        const cameraId = sessaoUI.cameraIds.get(cameraSocketId);
        if (cameraId) sessaoUI.camerasPorId.delete(cameraId);

        atualizarSessionEmptyState(sessaoUI);
    }

    function atualizarContagemObservadores(sessaoUI, cameraId, quantidade) {
        const elCard = sessaoUI.camerasPorId.get(cameraId);
        if (!elCard) return;
        elCard.querySelector('.camera-card-viewers-count').textContent = String(quantidade);
    }

    function atualizarOrientacaoCamera(sessaoUI, cameraId, vertical) {
        const elCard = sessaoUI.camerasPorId.get(cameraId);
        if (!elCard) return;
        elCard.classList.toggle('camera-card-vertical', vertical);
    }

    function criarPeerConnectionParaCamera(sessaoUI, iceConfig, cameraSocketId) {
        const pc = new RTCPeerConnection({ iceServers: montarIceServers(iceConfig) });
        sessaoUI.peerConnections.set(cameraSocketId, pc);

        pc.ontrack = (event) => {
            const video = criarCardCamera(sessaoUI, cameraSocketId, sessaoUI.cameraIds.get(cameraSocketId));
            if (video.srcObject !== event.streams[0]) {
                video.srcObject = event.streams[0];
                video.closest('.camera-card').querySelector('.camera-card-label').textContent = 'Ao vivo';
                video.play().catch(() => {});
            }
        };

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                sessaoUI.connection.emit('enviarIceCandidate', {
                    targetSocketId: cameraSocketId,
                    candidate: event.candidate
                });
            }
        };

        pc.onconnectionstatechange = () => {
            console.info(`[WebRTC] Estado da conexão com câmera ${cameraSocketId}: ${pc.connectionState}`);
            if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                sessaoUI.peerConnections.delete(cameraSocketId);
                removerCardCamera(sessaoUI, cameraSocketId);
            }
        };

        return pc;
    }

    function encerrarPeerConnection(sessaoUI, cameraSocketId) {
        const pc = sessaoUI.peerConnections.get(cameraSocketId);
        if (pc) {
            pc.close();
            sessaoUI.peerConnections.delete(cameraSocketId);
        }
        removerCardCamera(sessaoUI, cameraSocketId);
    }

    async function adicionarSessao(token) {
        if (sessoes.has(token)) return;

        const elCard = criarSecaoSessao(token);
        const sessaoUI = {
            token,
            connection: null,
            peerConnections: new Map(),
            videoElements: new Map(),
            cameraIds: new Map(),
            camerasPorId: new Map(),
            elCard
        };
        sessoes.set(token, sessaoUI);
        atualizarEmptyState();

        const iceConfig = await buscarIceConfig(serverUrl);

        const connection = criarConexaoSocket(serverUrl, (estado, conexaoAtual) => {
            if (estado === 'conectado') {
                conexaoAtual.emit('entrarComoDashboard', token);
            }
        });
        sessaoUI.connection = connection;

        connection.on('novaCameraConectada', ({ socketId, cameraId }) => {
            sessaoUI.cameraIds.set(socketId, cameraId);
            criarCardCamera(sessaoUI, socketId, cameraId);
        });

        connection.on('cameraDesconectada', ({ socketId }) => {
            sessaoUI.cameraIds.delete(socketId);
            encerrarPeerConnection(sessaoUI, socketId);
        });

        connection.on('contagemObservadoresAtualizada', ({ cameraId, quantidade }) => {
            atualizarContagemObservadores(sessaoUI, cameraId, quantidade);
        });

        connection.on('orientacaoCameraAtualizada', ({ cameraId, vertical }) => {
            atualizarOrientacaoCamera(sessaoUI, cameraId, vertical);
        });

        connection.on('receberOffer', async ({ senderSocketId, sdpOffer }) => {
            if (sessaoUI.peerConnections.has(senderSocketId)) {
                sessaoUI.peerConnections.get(senderSocketId).close();
            }
            const pc = criarPeerConnectionParaCamera(sessaoUI, iceConfig, senderSocketId);

            await pc.setRemoteDescription(new RTCSessionDescription(sdpOffer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            connection.emit('enviarAnswer', { targetSocketId: senderSocketId, sdpAnswer: answer });
        });

        connection.on('receberIceCandidate', async ({ senderSocketId, candidate }) => {
            const pc = sessaoUI.peerConnections.get(senderSocketId);
            if (!pc) return;
            try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (erro) {
                console.error('[WebRTC] Erro ao adicionar ICE candidate:', erro);
            }
        });

        connection.on('erro', (mensagem) => {
            console.error(`[Dashboard] Erro do servidor (token=${token}):`, mensagem);
        });
    }

    async function removerSessao(token) {
        const sessaoUI = sessoes.get(token);
        if (!sessaoUI) return;

        sessaoUI.peerConnections.forEach((pc) => pc.close());
        sessaoUI.connection?.disconnect();
        sessaoUI.elCard.remove();
        sessoes.delete(token);

        atualizarEmptyState();

        try {
            await fetch(`${serverUrl}/api/sessions/${encodeURIComponent(token)}`, { method: 'DELETE' });
        } catch (erro) {
            console.error('[Dashboard] Erro ao remover sessão no servidor:', erro);
        }
    }

    async function criarNovaSessao(expiracaoMinutos) {
        const resposta = await fetch(`${serverUrl}/api/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expiracaoMinutos: expiracaoMinutos ? Number(expiracaoMinutos) : null })
        });
        const dados = await resposta.json();
        await adicionarSessao(dados.token);
    }

    document.getElementById('form-criar').addEventListener('submit', async (event) => {
        event.preventDefault();
        const expiracaoMinutos = document.getElementById('input-expiracao').value || null;
        await criarNovaSessao(expiracaoMinutos);
        document.getElementById('input-expiracao').value = '';
    });

    // Restaura sessões salvas (de qualquer dispositivo) ao carregar a página.
    carregarTokensSalvos().then((tokens) => {
        tokens.forEach((token) => adicionarSessao(token));
        atualizarEmptyState();
    });
})();
