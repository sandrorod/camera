// dashboard.js
// Controla o dashboard: mantém um único link ativo por vez (persistido no banco,
// via API do servidor) para que apareça em qualquer dispositivo, não só no
// navegador que gerou o link. Ao gerar um novo link, o anterior é removido no
// servidor e substituído. Abre uma conexão Socket.io para a sessão ativa, cria
// uma RTCPeerConnection por câmera conectada, e renderiza um card com vídeo para
// cada uma no grid. Cards aparecem/desaparecem automaticamente conforme câmeras
// conectam/desconectam.

(function () {
    const serverUrl = window.__SECURITYCAM_CONFIG__.serverUrl;

    const elCamerasGrid = document.getElementById('cameras-grid');
    const elEmptyState = document.getElementById('empty-state');
    const elLinkAtual = document.getElementById('input-link-atual');
    const elBtnCopiarLink = document.getElementById('btn-copiar-link');
    const elBtnQrcodeLink = document.getElementById('btn-qrcode-link');
    const elBtnGerarNovoLink = document.getElementById('btn-gerar-novo-link');
    const elQrcodeModal = document.getElementById('qrcode-modal');
    const elQrcodeCanvas = document.getElementById('qrcode-canvas');
    const elBtnFecharQrcodeModal = document.getElementById('btn-fechar-qrcode-modal');
    const templateCameraCard = document.getElementById('template-camera-card');
    const elChatModal = document.getElementById('chat-modal');
    const elChatModalTitulo = document.getElementById('chat-modal-titulo');
    const elChatMensagens = document.getElementById('chat-mensagens');
    const elChatForm = document.getElementById('chat-form');
    const elChatInput = document.getElementById('chat-input');
    const elBtnFecharChatModal = document.getElementById('btn-fechar-chat-modal');
    const templateChatMensagem = document.getElementById('template-chat-mensagem');

    let qrcode = null;

    /** cameraId da conversa aberta no momento no modal de chat, ou null se fechado. */
    let chatAbertoCameraId = null;

    /** Estado da única sessão ativa no dashboard. */
    let sessaoAtual = null;

    const CHAVE_TOKEN_ATUAL = 'securitycam:tokenAtual';

    function salvarTokenLocal(token) {
        try {
            localStorage.setItem(CHAVE_TOKEN_ATUAL, token);
        } catch (erro) {
            console.warn('[Dashboard] Não foi possível salvar o token localmente:', erro);
        }
    }

    function lerTokenLocal() {
        try {
            return localStorage.getItem(CHAVE_TOKEN_ATUAL);
        } catch (erro) {
            return null;
        }
    }

    /**
     * @typedef {Object} SessaoUI
     * @property {string} token
     * @property {any} connection - socket.io
     * @property {Map<string, RTCPeerConnection>} peerConnections
     * @property {Map<string, HTMLVideoElement>} videoElements
     * @property {Map<string, string>} cameraIds - socketId -> cameraId persistente
     * @property {Map<string, HTMLElement>} camerasPorId - cameraId -> elemento .camera-card
     * @property {string|null} cameraAtivaId - cameraId exibido no link de visualização único
     * @property {Map<string, Array>} mensagensPorCamera - cameraId -> histórico de mensagens do chat, isolado por câmera
     * @property {Map<string, number>} naoLidasPorCamera - cameraId -> contagem de mensagens não lidas
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
        const temCameras = sessaoAtual && sessaoAtual.videoElements.size > 0;
        elEmptyState.classList.toggle('hidden', !!temCameras);
    }

    function linkCameraPara(token) {
        return `${window.location.origin}/camera.html?token=${encodeURIComponent(token)}`;
    }

    function linkVisualizacaoPara(token) {
        return `${window.location.origin}/watch.html?token=${encodeURIComponent(token)}`;
    }

    function linkVisualizacaoIndividualPara(token, cameraId) {
        return `${window.location.origin}/watch.html?token=${encodeURIComponent(token)}&camera=${encodeURIComponent(cameraId)}`;
    }

    function copiarTexto(texto, elBotao, mostrarFeedback = mostrarFeedbackCopiado) {
        const executarFallback = () => {
            const temp = document.createElement('textarea');
            temp.value = texto;
            document.body.appendChild(temp);
            temp.select();
            document.execCommand('copy');
            temp.remove();
        };

        const promessa = navigator.clipboard?.writeText(texto) ?? Promise.reject();
        promessa.catch(executarFallback).finally(() => {
            if (elBotao) mostrarFeedback(elBotao);
        });
    }

    function mostrarFeedbackCopiado(elBotao) {
        if (elBotao.dataset.feedbackAtivo) return;
        elBotao.dataset.feedbackAtivo = '1';

        const textoOriginal = elBotao.textContent;
        elBotao.textContent = '✅ Copiado!';
        elBotao.classList.add('btn-copiado');

        setTimeout(() => {
            elBotao.textContent = textoOriginal;
            elBotao.classList.remove('btn-copiado');
            delete elBotao.dataset.feedbackAtivo;
        }, 1500);
    }

    /** Mesmo feedback de cópia, mas para botões só-ícone: troca o emoji sem adicionar texto. */
    function mostrarFeedbackCopiadoIcone(elBotao) {
        if (elBotao.dataset.feedbackAtivo) return;
        elBotao.dataset.feedbackAtivo = '1';

        const textoOriginal = elBotao.textContent;
        elBotao.textContent = '✅';
        elBotao.classList.add('btn-copiado');

        setTimeout(() => {
            elBotao.textContent = textoOriginal;
            elBotao.classList.remove('btn-copiado');
            delete elBotao.dataset.feedbackAtivo;
        }, 1500);
    }

    function atualizarLinks(token) {
        elLinkAtual.value = linkCameraPara(token);
    }

    function abrirQrcodeModal(link) {
        elQrcodeCanvas.innerHTML = '';
        qrcode = new QRCode(elQrcodeCanvas, {
            text: link,
            width: 320,
            height: 320,
            colorDark: '#0b0f14',
            colorLight: '#eef2f6',
            correctLevel: QRCode.CorrectLevel.H
        });
        elQrcodeModal.classList.remove('hidden');
    }

    function fecharQrcodeModal() {
        elQrcodeModal.classList.add('hidden');
        elQrcodeCanvas.innerHTML = '';
    }

    elBtnCopiarLink.addEventListener('click', () => copiarTexto(elLinkAtual.value, elBtnCopiarLink));
    elBtnQrcodeLink.addEventListener('click', () => abrirQrcodeModal(elLinkAtual.value));
    elBtnFecharQrcodeModal.addEventListener('click', fecharQrcodeModal);
    elQrcodeModal.querySelector('.qrcode-modal-backdrop').addEventListener('click', fecharQrcodeModal);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !elQrcodeModal.classList.contains('hidden')) fecharQrcodeModal();
    });

    function limparCamerasUI() {
        elCamerasGrid.innerHTML = '';
    }

    function criarCardCamera(sessaoUI, cameraSocketId, cameraId, dadosTorcedor) {
        if (sessaoUI.videoElements.has(cameraSocketId)) {
            return sessaoUI.videoElements.get(cameraSocketId);
        }

        const fragment = templateCameraCard.content.cloneNode(true);
        const elCard = fragment.querySelector('.camera-card');
        const video = fragment.querySelector('video');
        const elTorcedor = fragment.querySelector('.camera-card-torcedor');

        if (dadosTorcedor?.nome || dadosTorcedor?.time) {
            const partes = [dadosTorcedor.nome, dadosTorcedor.time && `torcendo pro ${dadosTorcedor.time}`].filter(Boolean);
            elTorcedor.textContent = partes.join(' — ');
            elTorcedor.classList.remove('hidden');
        }
        const elBtnSelecionar = fragment.querySelector('.btn-selecionar-camera');
        const elBtnCopiarCameraIndividual = fragment.querySelector('.btn-copiar-camera-individual');
        const elBtnCopiarCameraLink = fragment.querySelector('.btn-copiar-camera-link');
        const elBtnSilenciar = fragment.querySelector('.btn-silenciar-camera');
        const elBtnChat = fragment.querySelector('.btn-chat-camera');
        const elBtnDesconectar = fragment.querySelector('.btn-desconectar-camera');

        if (cameraId) {
            elBtnSelecionar.addEventListener('click', () => {
                sessaoUI.connection?.emit('selecionarCameraAtiva', { token: sessaoUI.token, cameraId });
            });
            elBtnCopiarCameraIndividual.addEventListener('click', () => {
                copiarTexto(linkVisualizacaoIndividualPara(sessaoUI.token, cameraId), elBtnCopiarCameraIndividual, mostrarFeedbackCopiadoIcone);
            });
            elBtnCopiarCameraLink.addEventListener('click', () => {
                copiarTexto(linkVisualizacaoPara(sessaoUI.token), elBtnCopiarCameraLink, mostrarFeedbackCopiadoIcone);
            });
            elBtnSilenciar.addEventListener('click', () => {
                sessaoUI.connection?.emit('alternarSilenciarCamera', { token: sessaoUI.token, cameraId });
            });
            elBtnChat.addEventListener('click', () => abrirChatModal(sessaoUI, cameraId));
            elBtnDesconectar.addEventListener('click', () => {
                if (!confirm('Desconectar esta câmera? A transmissão dela será encerrada.')) return;
                sessaoUI.connection?.emit('desconectarCamera', { token: sessaoUI.token, cameraId });
            });
        } else {
            elBtnSelecionar.disabled = true;
            elBtnCopiarCameraIndividual.disabled = true;
            elBtnCopiarCameraLink.disabled = true;
            elBtnSilenciar.disabled = true;
            elBtnChat.disabled = true;
            elBtnDesconectar.disabled = true;
        }

        elCamerasGrid.appendChild(fragment);
        elCard.dataset.socketId = cameraSocketId;
        if (cameraId) elCard.dataset.cameraId = cameraId;

        sessaoUI.videoElements.set(cameraSocketId, video);
        if (cameraId) sessaoUI.camerasPorId.set(cameraId, elCard);
        atualizarEmptyState();
        atualizarMarcacaoCameraAtiva(sessaoUI);
        return video;
    }

    function atualizarMarcacaoCameraAtiva(sessaoUI) {
        sessaoUI.camerasPorId.forEach((elCard, cameraId) => {
            const ativa = cameraId === sessaoUI.cameraAtivaId;
            elCard.classList.toggle('camera-card-selecionada', ativa);
            const elBtn = elCard.querySelector('.btn-selecionar-camera');
            elBtn.title = ativa ? 'Câmera selecionada no link único de visualização' : 'Exibir esta câmera no link único de visualização';
            elBtn.classList.toggle('selecionada', ativa);
        });
    }

    function atualizarMarcacaoSilenciada(sessaoUI, cameraId, silenciada) {
        const elCard = sessaoUI.camerasPorId.get(cameraId);
        if (!elCard) return;
        const elBtn = elCard.querySelector('.btn-silenciar-camera');
        elBtn.textContent = silenciada ? '🔇' : '🔊';
        elBtn.title = silenciada ? 'Reativar áudio para quem está assistindo' : 'Silenciar áudio para quem está assistindo';
        elBtn.classList.toggle('silenciada', silenciada);
    }

    function formatarHora(timestamp) {
        return new Date(timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }

    function renderizarMensagemChat(mensagem) {
        const fragment = templateChatMensagem.content.cloneNode(true);
        const elMensagem = fragment.querySelector('.chat-mensagem');
        elMensagem.classList.toggle('chat-mensagem-dashboard', mensagem.remetente === 'dashboard');
        elMensagem.querySelector('.chat-mensagem-texto').textContent = mensagem.texto;
        elMensagem.querySelector('.chat-mensagem-hora').textContent = formatarHora(mensagem.enviadaEm);
        elChatMensagens.appendChild(fragment);
        elChatMensagens.scrollTop = elChatMensagens.scrollHeight;
    }

    function atualizarBadgeChat(sessaoUI, cameraId) {
        const elCard = sessaoUI.camerasPorId.get(cameraId);
        if (!elCard) return;
        const quantidade = sessaoUI.naoLidasPorCamera.get(cameraId) || 0;
        const elBadge = elCard.querySelector('.chat-badge');
        elBadge.textContent = String(quantidade);
        elBadge.classList.toggle('hidden', quantidade === 0);
    }

    function receberMensagemChat(sessaoUI, mensagem) {
        if (!sessaoUI.mensagensPorCamera.has(mensagem.cameraId)) {
            sessaoUI.mensagensPorCamera.set(mensagem.cameraId, []);
        }
        sessaoUI.mensagensPorCamera.get(mensagem.cameraId).push(mensagem);

        if (chatAbertoCameraId === mensagem.cameraId) {
            renderizarMensagemChat(mensagem);
        } else if (mensagem.remetente !== 'dashboard') {
            const atual = sessaoUI.naoLidasPorCamera.get(mensagem.cameraId) || 0;
            sessaoUI.naoLidasPorCamera.set(mensagem.cameraId, atual + 1);
            atualizarBadgeChat(sessaoUI, mensagem.cameraId);
        }
    }

    function abrirChatModal(sessaoUI, cameraId) {
        chatAbertoCameraId = cameraId;
        elChatModalTitulo.textContent = `Chat com a câmera`;
        elChatMensagens.innerHTML = '';
        (sessaoUI.mensagensPorCamera.get(cameraId) || []).forEach(renderizarMensagemChat);

        sessaoUI.naoLidasPorCamera.set(cameraId, 0);
        atualizarBadgeChat(sessaoUI, cameraId);

        elChatModal.classList.remove('hidden');
        elChatInput.value = '';
        elChatInput.focus();

        elChatForm.onsubmit = (event) => {
            event.preventDefault();
            const texto = elChatInput.value.trim();
            if (!texto) return;

            const mensagem = { cameraId, remetente: 'dashboard', texto, enviadaEm: Date.now() };
            sessaoUI.connection?.emit('enviarMensagemChat', { token: sessaoUI.token, cameraId, remetente: 'dashboard', texto });
            receberMensagemChat(sessaoUI, mensagem);
            elChatInput.value = '';
        };
    }

    function fecharChatModal() {
        chatAbertoCameraId = null;
        elChatModal.classList.add('hidden');
    }

    elBtnFecharChatModal.addEventListener('click', fecharChatModal);
    elChatModal.querySelector('.chat-modal-backdrop').addEventListener('click', fecharChatModal);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !elChatModal.classList.contains('hidden')) fecharChatModal();
    });

    function removerCardCamera(sessaoUI, cameraSocketId) {
        const video = sessaoUI.videoElements.get(cameraSocketId);
        if (!video) return;

        video.srcObject = null;
        video.closest('.camera-card')?.remove();
        sessaoUI.videoElements.delete(cameraSocketId);

        const cameraId = sessaoUI.cameraIds.get(cameraSocketId);
        if (cameraId) sessaoUI.camerasPorId.delete(cameraId);

        atualizarEmptyState();
    }

    function atualizarContagemObservadores(sessaoUI, cameraId, quantidade) {
        const elCard = sessaoUI.camerasPorId.get(cameraId);
        if (!elCard) return;
        elCard.querySelector('.camera-card-viewers-count').textContent = String(quantidade);
    }

    function atualizarOrientacaoCamera(sessaoUI, cameraId, vertical, invertido) {
        const elCard = sessaoUI.camerasPorId.get(cameraId);
        if (!elCard) return;
        elCard.classList.toggle('camera-card-vertical', vertical);
        elCard.querySelector('video').classList.toggle('camera-card-video-invertido', !!invertido);
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

    async function conectarSessao(token) {
        salvarTokenLocal(token);

        const sessaoUI = {
            token,
            connection: null,
            peerConnections: new Map(),
            videoElements: new Map(),
            cameraIds: new Map(),
            camerasPorId: new Map(),
            cameraAtivaId: null,
            mensagensPorCamera: new Map(),
            naoLidasPorCamera: new Map()
        };
        sessaoAtual = sessaoUI;

        limparCamerasUI();
        atualizarLinks(token);
        atualizarEmptyState();

        const iceConfig = await buscarIceConfig(serverUrl);
        if (sessaoAtual !== sessaoUI) return; // trocado enquanto aguardava

        const connection = criarConexaoSocket(serverUrl, (estado, conexaoAtual) => {
            if (estado === 'conectado') {
                conexaoAtual.emit('entrarComoDashboard', token);
            }
        });
        sessaoUI.connection = connection;

        connection.on('novaCameraConectada', ({ socketId, cameraId, nome, time }) => {
            sessaoUI.cameraIds.set(socketId, cameraId);
            criarCardCamera(sessaoUI, socketId, cameraId, { nome, time });
        });

        connection.on('cameraDesconectada', ({ socketId }) => {
            sessaoUI.cameraIds.delete(socketId);
            encerrarPeerConnection(sessaoUI, socketId);
        });

        connection.on('contagemObservadoresAtualizada', ({ cameraId, quantidade }) => {
            atualizarContagemObservadores(sessaoUI, cameraId, quantidade);
        });

        connection.on('orientacaoCameraAtualizada', ({ cameraId, vertical, invertido }) => {
            atualizarOrientacaoCamera(sessaoUI, cameraId, vertical, invertido);
        });

        connection.on('cameraAtivaAtualizada', ({ cameraId }) => {
            sessaoUI.cameraAtivaId = cameraId;
            atualizarMarcacaoCameraAtiva(sessaoUI);
        });

        connection.on('cameraSilenciadaAtualizada', ({ cameraId, silenciada }) => {
            atualizarMarcacaoSilenciada(sessaoUI, cameraId, silenciada);
        });

        connection.on('mensagemChatRecebida', (mensagem) => {
            receberMensagemChat(sessaoUI, mensagem);
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

    async function desconectarSessaoAtual() {
        if (!sessaoAtual) return;
        const tokenAntigo = sessaoAtual.token;

        sessaoAtual.peerConnections.forEach((pc) => pc.close());
        sessaoAtual.connection?.disconnect();
        sessaoAtual = null;
        limparCamerasUI();

        try {
            await fetch(`${serverUrl}/api/sessions/${encodeURIComponent(tokenAntigo)}`, { method: 'DELETE' });
        } catch (erro) {
            console.error('[Dashboard] Erro ao remover sessão antiga no servidor:', erro);
        }
    }

    async function gerarNovoLink() {
        await desconectarSessaoAtual();

        const resposta = await fetch(`${serverUrl}/api/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const dados = await resposta.json();
        await conectarSessao(dados.token);
    }

    elBtnGerarNovoLink.addEventListener('click', () => gerarNovoLink());

    // Restaura o link ativo ao carregar a página. O token fica salvo no
    // localStorage deste navegador (fonte primária, pois o servidor só lista
    // tokens que já têm câmera conectada); em outro dispositivo sem token local,
    // cai para o último token com câmeras registradas no servidor. Se nenhum dos
    // dois existir, gera um novo automaticamente para que o dashboard sempre
    // tenha um único link ativo pronto para compartilhar.
    (async () => {
        const tokenLocal = lerTokenLocal();
        if (tokenLocal) {
            await conectarSessao(tokenLocal);
            return;
        }

        const tokens = await carregarTokensSalvos();
        if (tokens.length > 0) {
            await conectarSessao(tokens[0]);
        } else {
            await gerarNovoLink();
        }
    })();
})();
