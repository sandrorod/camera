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
    const elBtnStart = document.getElementById('btn-start');
    const elBtnStop = document.getElementById('btn-stop');
    const elBtnSwitchCamera = document.getElementById('btn-switch-camera');
    const elQualityLabel = document.getElementById('quality-label');
    const elFpsLabel = document.getElementById('fps-label');
    const elStatusMessage = document.getElementById('status-message');
    const elBannerVideoCongelado = document.getElementById('banner-video-congelado');
    const elBannerNoAr = document.getElementById('banner-no-ar');
    const elInputNomeTorcedor = document.getElementById('input-nome-torcedor');
    const elInputTimeTorcedor = document.getElementById('input-time-torcedor');
    const elBtnAbrirChat = document.getElementById('btn-abrir-chat');
    const elChatBadgeCamera = document.getElementById('chat-badge-camera');
    const elChatModal = document.getElementById('chat-modal');
    const elChatMensagens = document.getElementById('chat-mensagens');
    const elChatForm = document.getElementById('chat-form');
    const elChatInput = document.getElementById('chat-input');
    const elBtnFecharChatModal = document.getElementById('btn-fechar-chat-modal');
    const templateChatMensagem = document.getElementById('template-chat-mensagem');

    /** FPS fixo: a opção de escolher FPS foi removida da UI em favor dos
     * campos de nome/time, e 30fps é a melhor opção padrão (fluidez sem
     * exigir mais banda do que o necessário). */
    const FPS_PADRAO = 30;

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
                // Sem isso, a variável continua apontando pra um lock já
                // inválido e o polling de readquisição nunca dispara de novo —
                // causa raiz da tela apagar permanentemente após a primeira
                // liberação automática pelo sistema.
                console.info('[WakeLock] Liberado pelo sistema.');
                wakeLock = null;
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
     * aba em foco, fora do ciclo de vida documentado pela API, ou nunca chegam
     * a conceder o lock por gerenciamento agressivo de energia. Verifica com
     * frequência e readquire em todo gatilho disponível de retorno de foco,
     * como camada extra de defesa além do listener de visibilitychange.
     */
    setInterval(() => {
        if (transmitindo && !wakeLock) {
            adquirirWakeLock();
        }
    }, 5000);

    document.addEventListener('visibilitychange', () => {
        if (transmitindo && document.visibilityState === 'visible') {
            if (!wakeLock) adquirirWakeLock();
            verificarSeCongelouAoVoltar();
        }
    });

    window.addEventListener('focus', () => {
        if (transmitindo && !wakeLock) {
            adquirirWakeLock();
        }
    });

    window.addEventListener('pageshow', () => {
        if (transmitindo && !wakeLock) {
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
     * tentando a maior resolução suportada (4K, com fallback decrescente até
     * SD) — sem seleção manual, a UI sempre busca a melhor qualidade possível.
     */
    async function iniciarCaptura() {
        elConnectionOverlay.classList.remove('hidden');
        elConnectionOverlay.querySelector('p').textContent = 'Solicitando permissão da câmera...';

        const { stream, resolucao } = await obterMelhorStreamDisponivel(RESOLUCOES_PADRAO, facingModeAtual, FPS_PADRAO);

        localStream = stream;
        elLocalPreview.srcObject = stream;
        elConnectionOverlay.classList.add('hidden');

        const trackSettings = stream.getVideoTracks()[0]?.getSettings() ?? {};
        const fpsReal = Math.round(trackSettings.frameRate || FPS_PADRAO);
        atualizarIndicadorQualidade(
            { width: trackSettings.width || resolucao.width, height: trackSettings.height || resolucao.height },
            fpsReal
        );

        notificarOrientacaoSeMudou();
        monitorarFpsReal(stream);
    }

    /**
     * A resolução da track de vídeo (width/height) NÃO reflete a orientação
     * física do celular — o sensor da câmera captura sempre na mesma
     * orientação nativa (geralmente paisagem), e é a rotação do dispositivo
     * que gira a imagem na exibição via metadata, não a resolução em si. Por
     * isso a orientação real precisa vir de screen.orientation.
     *
     * Neste app o retrato (vertical) já sai correto nativamente via WebRTC,
     * mas a paisagem (landscape) sai sempre de cabeça para baixo nos dois
     * sentidos de rotação — não é um caso de landscape-primary vs
     * landscape-secondary (já testamos essa distinção e não bate com o
     * comportamento real observado), é a orientação paisagem como um todo
     * que precisa da correção. Por isso a rotação de 180° é aplicada sempre
     * que o celular estiver em paisagem, independente do sentido do giro.
     */
    function celularEstaVertical() {
        if (screen.orientation?.type) {
            return screen.orientation.type.startsWith('portrait');
        }
        return window.matchMedia('(orientation: portrait)').matches;
    }

    /**
     * A correção de rotação em paisagem só vale para celular/tablet — a
     * webcam de um computador é sempre "paisagem" por natureza (não tem
     * sensor de rotação), e aplicar a mesma correção nela deixava a imagem
     * de cabeça para baixo desnecessariamente. userAgentData.mobile é a
     * forma mais direta de checar; o fallback por regex de user agent cobre
     * navegadores que ainda não suportam essa API.
     */
    function ehDispositivoMovel() {
        if (typeof navigator.userAgentData?.mobile === 'boolean') {
            return navigator.userAgentData.mobile;
        }
        return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    }

    /**
     * Entra em tela cheia automaticamente quando o celular é girado para
     * paisagem durante a transmissão, e sai ao voltar para retrato — assim o
     * preview aproveita a tela toda sem precisar de um botão manual. Ignora
     * erros: alguns navegadores exigem que a chamada aconteça diretamente
     * dentro de um gesto do usuário, e nesses casos falha silenciosamente.
     */
    function ajustarTelaCheiaPelaOrientacao(vertical) {
        if (!transmitindo) return;

        if (!vertical && !document.fullscreenElement) {
            document.documentElement.requestFullscreen?.().catch(() => {});
        } else if (vertical && document.fullscreenElement) {
            document.exitFullscreen?.().catch(() => {});
        }
    }

    let orientacaoAtual = null;
    function notificarOrientacaoSeMudou() {
        const vertical = celularEstaVertical();
        ajustarTelaCheiaPelaOrientacao(vertical);

        if (orientacaoAtual === vertical) return;
        orientacaoAtual = vertical;

        if (connection && connection.connected) {
            // invertido só é relevante em paisagem, e só em dispositivo móvel
            // (webcam de PC não sofre desse problema — ver ehDispositivoMovel).
            const invertido = !vertical && ehDispositivoMovel();
            connection.emit('orientacaoAtualizada', { token: config.token, vertical, invertido });
        }
    }

    screen.orientation?.addEventListener('change', notificarOrientacaoSeMudou);
    window.addEventListener('orientationchange', notificarOrientacaoSeMudou);

    document.addEventListener('fullscreenchange', () => {
        // Se o usuário sair manualmente da tela cheia (ex: gesto do sistema) e
        // o celular continuar em paisagem, tenta reentrar — melhor esforço,
        // pode ser bloqueado pelo navegador fora de um gesto direto do usuário.
        if (!document.fullscreenElement && transmitindo && !celularEstaVertical()) {
            document.documentElement.requestFullscreen?.().catch(() => {});
        }
    });

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
     * Android/Chrome costuma pausar a captura de vídeo assim que a aba vai
     * para segundo plano por tempo prolongado (economia de bateria), mesmo com
     * a RTCPeerConnection continuando "conectada" e o socket vivo — o vídeo
     * fica congelado no último frame sem nenhum aviso visível para quem está
     * transmitindo. Não é possível evitar isso de forma confiável (limitação
     * de plataforma), mas dá para detectar via requestVideoFrameCallback (novo
     * frame chegando ou não) e avisar o usuário ao voltar ao app.
     */
    let ultimoFrameRecebidoEm = null;
    let monitorandoCongelamento = false;

    function iniciarMonitoramentoCongelamento() {
        if (monitorandoCongelamento || !elLocalPreview.requestVideoFrameCallback) return;
        monitorandoCongelamento = true;

        const registrarFrame = () => {
            ultimoFrameRecebidoEm = Date.now();
            if (transmitindo) {
                elLocalPreview.requestVideoFrameCallback(registrarFrame);
            } else {
                monitorandoCongelamento = false;
            }
        };
        elLocalPreview.requestVideoFrameCallback(registrarFrame);
    }

    /**
     * Ao voltar de segundo plano, se o último frame recebido é mais antigo que
     * alguns segundos, o vídeo provavelmente congelou enquanto a aba estava em
     * background — mostra o aviso. O aviso some sozinho assim que um frame
     * novo chegar (prova de que a captura foi retomada).
     */
    const LIMITE_CONGELAMENTO_MS = 4000;

    function verificarSeCongelouAoVoltar() {
        if (!transmitindo || ultimoFrameRecebidoEm === null) return;

        const tempoDesdeUltimoFrame = Date.now() - ultimoFrameRecebidoEm;
        if (tempoDesdeUltimoFrame > LIMITE_CONGELAMENTO_MS) {
            mostrarAvisoVideoCongelado();
        }
    }

    function mostrarAvisoVideoCongelado() {
        if (!elBannerVideoCongelado.classList.contains('hidden')) return;

        elBannerVideoCongelado.classList.remove('hidden');
        navigator.vibrate?.([200, 100, 200]);

        // O primeiro frame após o congelamento normalmente já estava enfileirado
        // antes da aba voltar ao foreground, então não prova por si só que a
        // captura foi retomada — espera mais um frame subsequente antes de
        // esconder o aviso, para reduzir a chance de escondê-lo cedo demais.
        const marcarFrameOk = () => {
            elLocalPreview.requestVideoFrameCallback(() => {
                elBannerVideoCongelado.classList.add('hidden');
            });
        };
        elLocalPreview.requestVideoFrameCallback(marcarFrameOk);
    }

    /**
     * O WebRTC aplica por padrão um teto de bitrate conservador (~1-2.5 Mbps)
     * independente da resolução da track. Um teto alto demais (chegamos a usar
     * 20 Mbps para 4K) excede a banda de UPLOAD real da maioria das redes
     * móveis/wifi residencial, fazendo o GCC (controle de congestionamento)
     * reagir tarde e causando bufferbloat/travamentos — mesmo a rede aguentando
     * o download do lado de quem assiste. Estes valores ficam próximos ao que
     * upload móvel típico sustenta; o GCC ainda reduz dinamicamente abaixo
     * deste teto se a rede real for pior.
     */
    function bitrateMaximoParaResolucao(largura, altura) {
        const pixels = largura * altura;
        if (pixels >= 3840 * 2160) return 15_000_000;  // 4K
        if (pixels >= 1920 * 1080) return 7_000_000;   // Full HD
        if (pixels >= 1280 * 720) return 3_500_000;    // HD
        return 1_500_000;                               // SD
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
        // Sem isso, o scaleResolutionDownBy fica implícito em 1, mas alguns
        // navegadores/drivers já usam esse valor como sinal para não fazer
        // downscale — deixamos explícito para garantir resolução máxima.
        params.encodings[0].scaleResolutionDownBy = 1;

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
        // O servidor pode reenviar "novoEspectador" para o mesmo dashboard (ex:
        // ele reconectou e a câmera ainda está marcada como ativa). Reaproveitar
        // uma PC que já está negociando/conectada evita Offers duplicados e
        // Answers chegando fora de ordem em PCs diferentes para o mesmo destino.
        const pcExistente = peerConnections.get(dashboardSocketId);
        if (pcExistente && pcExistente.connectionState !== 'failed' && pcExistente.connectionState !== 'closed') {
            return pcExistente;
        }

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

    /** Monta o payload de identificação enviado ao entrar na sessão como câmera. */
    function obterDadosTorcedor() {
        return {
            nome: elInputNomeTorcedor.value.trim().slice(0, 60) || null,
            time: elInputTimeTorcedor.value.trim().slice(0, 60) || null
        };
    }

    async function configurarSocket() {
        iceConfig = await buscarIceConfig(config.serverUrl);

        connection = criarConexaoSocket(config.serverUrl, (estado, conexaoAtual) => {
            if (estado === 'reconectando') {
                definirStatus('Conexão perdida. Tentando reconectar automaticamente...');
            } else if (estado === 'conectado' && transmitindo) {
                definirStatus('Reconectado. Retomando transmissão...');
                conexaoAtual.emit('entrarComoCamera', { token: config.token, cameraId, ...obterDadosTorcedor() });
            }
        });

        connection.on('cameraConfirmada', () => {
            definirStatus('Transmissão ativa. Aguardando conexão com o dashboard...');

            // Garante que a orientação inicial seja enviada agora que a conexão existe
            // (na primeira captura, a conexão ainda não tinha sido criada).
            orientacaoAtual = null;
            notificarOrientacaoSeMudou();
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
            // Ignora Answers que cheguem fora de ordem (ex: dashboard reenviou
            // novoEspectador e uma nova PC já substituiu esta no Map) — aplicar
            // um Answer quando a PC já está "stable" lança InvalidStateError.
            if (!pc || pc.signalingState !== 'have-local-offer') return;
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

        // Disparado pelo servidor quando o dashboard clica em "Desconectar" neste
        // card: encerra a transmissão localmente sem reenviar 'pararTransmissao'
        // (o servidor já limpou o estado da sessão do lado dele).
        connection.on('forcarDesconexao', () => {
            pararTransmissao(false);
            definirStatus('Transmissão encerrada pelo dashboard.');
        });

        // Disparado pelo servidor quando o dashboard clica em "Silenciar" neste
        // card: desabilitar a track (em vez de removê-la) interrompe o áudio
        // para todos os peers já conectados sem precisar renegociar cada
        // RTCPeerConnection — a track continua existindo, só para de enviar.
        connection.on('definirSilenciada', (silenciada) => {
            localStream?.getAudioTracks().forEach((track) => {
                track.enabled = !silenciada;
            });
            definirStatus(silenciada ? 'Áudio silenciado pelo dashboard.' : 'Áudio reativado pelo dashboard.');
        });

        // Avisa visualmente (banner piscante) quando esta câmera é a que está
        // sendo exibida no link único de visualização do dashboard — sinal
        // claro pra quem está segurando o celular de que a imagem está "no ar".
        connection.on('cameraAtivaAtualizada', ({ cameraId: idAtivo }) => {
            elBannerNoAr.classList.toggle('hidden', idAtivo !== cameraId);
        });

        connection.on('mensagemChatRecebida', (mensagem) => {
            receberMensagemChat(mensagem);
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

            connection.emit('entrarComoCamera', { token: config.token, cameraId, ...obterDadosTorcedor() });

            transmitindo = true;
            elBtnStart.classList.add('hidden');
            elBtnStop.classList.remove('hidden');
            definirStatus('Transmissão iniciada. A câmera já aparece no dashboard.');

            iniciarHeartbeat();
            await adquirirWakeLock();
            iniciarMonitoramentoCongelamento();

            // Chamada dentro do gesto de clique do usuário (obrigatório para a
            // Fullscreen API funcionar sem exceção em navegadores restritivos).
            ajustarTelaCheiaPelaOrientacao(celularEstaVertical());
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
        ultimoFrameRecebidoEm = null;
        elBannerVideoCongelado.classList.add('hidden');
        elBannerNoAr.classList.add('hidden');

        if (document.fullscreenElement) {
            document.exitFullscreen?.().catch(() => {});
        }

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
        // Sem isso, o elemento <video> continua exibindo o último frame do
        // stream antigo mesmo com as tracks paradas — o preview local parecia
        // continuar "ao vivo" mesmo após a transmissão real ter encerrado.
        elLocalPreview.srcObject = null;

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

        const { stream } = await obterMelhorStreamDisponivel(RESOLUCOES_PADRAO, facingModeAtual, FPS_PADRAO);
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

    // ----- Chat com o dashboard -----
    // Conversa isolada por câmera: do lado da câmera só existe a própria
    // conversa (com "o" dashboard), então não precisa de seletor de conversa
    // como no lado do dashboard, que fala com N câmeras diferentes.

    let chatAberto = false;
    let mensagensNaoLidas = 0;
    const historicoChat = [];

    function formatarHora(timestamp) {
        return new Date(timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }

    function renderizarMensagemChat(mensagem) {
        const fragment = templateChatMensagem.content.cloneNode(true);
        const elMensagem = fragment.querySelector('.chat-mensagem');
        // No padrão WhatsApp, a própria mensagem fica à direita — deste lado
        // (câmera), "própria" é remetente === 'camera'.
        elMensagem.classList.toggle('chat-mensagem-propria', mensagem.remetente === 'camera');
        elMensagem.querySelector('.chat-mensagem-texto').textContent = mensagem.texto;
        elMensagem.querySelector('.chat-mensagem-hora').textContent = formatarHora(mensagem.enviadaEm);
        elChatMensagens.appendChild(fragment);
        elChatMensagens.scrollTop = elChatMensagens.scrollHeight;
    }

    function atualizarBadgeChat() {
        elChatBadgeCamera.textContent = String(mensagensNaoLidas);
        elChatBadgeCamera.classList.toggle('hidden', mensagensNaoLidas === 0);
    }

    function receberMensagemChat(mensagem) {
        if (mensagem.cameraId !== cameraId) return;

        historicoChat.push(mensagem);
        if (chatAberto) {
            renderizarMensagemChat(mensagem);
        } else if (mensagem.remetente === 'dashboard') {
            mensagensNaoLidas++;
            atualizarBadgeChat();
        }
    }

    function abrirChatModal() {
        chatAberto = true;
        elChatMensagens.innerHTML = '';
        historicoChat.forEach(renderizarMensagemChat);

        mensagensNaoLidas = 0;
        atualizarBadgeChat();
        elChatModal.classList.remove('hidden');
        elChatInput.value = '';
        elChatInput.focus();
    }

    function fecharChatModal() {
        chatAberto = false;
        elChatModal.classList.add('hidden');
    }

    elBtnAbrirChat.addEventListener('click', abrirChatModal);
    elBtnFecharChatModal.addEventListener('click', fecharChatModal);
    elChatModal.querySelector('.chat-modal-backdrop').addEventListener('click', fecharChatModal);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !elChatModal.classList.contains('hidden')) fecharChatModal();
    });

    elChatForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const texto = elChatInput.value.trim();
        if (!texto || !connection) return;

        const mensagem = { cameraId, remetente: 'camera', texto, enviadaEm: Date.now() };
        connection.emit('enviarMensagemChat', { token: config.token, cameraId, remetente: 'camera', texto });
        historicoChat.push(mensagem);
        renderizarMensagemChat(mensagem);
        elChatInput.value = '';
    });
})();
