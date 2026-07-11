// index.js
// Servidor de signaling WebRTC do SecurityCam: API REST para criar/consultar sessões
// e Socket.io para a troca de Offer/Answer/ICE entre câmeras e o dashboard que as assiste.
// O frontend estático (HTML/CSS/JS) é hospedado separadamente na Vercel; este
// servidor só cuida da negociação da conexão peer-to-peer, nunca do vídeo em si.

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const sessionStore = require('./sessionStore');
const db = require('./db');

const PORT = process.env.PORT || 4000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

const app = express();
app.use(express.json());
app.use(cors({
    origin: ALLOWED_ORIGINS.includes('*') ? true : ALLOWED_ORIGINS,
    credentials: true
}));

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: ALLOWED_ORIGINS.includes('*') ? true : ALLOWED_ORIGINS,
        credentials: true
    }
});

const STUN_SERVERS = (process.env.STUN_SERVERS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const TURN_SERVERS = process.env.TURN_URL
    ? [{
        urls: process.env.TURN_URL,
        username: process.env.TURN_USERNAME || '',
        credential: process.env.TURN_CREDENTIAL || ''
    }]
    : [];

function grupoSessao(token) {
    return `session-${token}`;
}

function notificarContagemObservadores(token, cameraId) {
    const quantidade = sessionStore.contarObservadores(token, cameraId);
    sessionStore.listarDashboards(token).forEach((dashboardSocketId) => {
        io.to(dashboardSocketId).emit('contagemObservadoresAtualizada', { cameraId, quantidade });
    });
}

// ----- API REST -----

app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});

app.post('/api/sessions', (_req, res) => {
    const sessao = sessionStore.criarSessao();

    res.json({
        token: sessao.token,
        iceServers: { stunServers: STUN_SERVERS, turnServers: TURN_SERVERS }
    });
});

app.get('/api/sessions', async (_req, res) => {
    const tokens = await db.listarTokensDeSessao();
    res.json({ tokens });
});

app.delete('/api/sessions/:token', async (req, res) => {
    await db.removerCamerasPorSessao(req.params.token);
    sessionStore.encerrarSessao(req.params.token);
    res.json({ ok: true });
});

app.get('/api/sessions/:token/status', (req, res) => {
    const sessao = sessionStore.obterSessao(req.params.token);
    if (!sessao) {
        return res.status(404).json({ erro: 'Sessão não encontrada.' });
    }

    res.json({
        token: sessao.token,
        ativa: sessao.ativa,
        expirada: sessionStore.sessaoExpirada(sessao),
        quantidadeCameras: sessao.cameras.size,
        ultimaAtividade: sessao.ultimaAtividade
    });
});

app.get('/api/ice-config', (_req, res) => {
    res.json({ stunServers: STUN_SERVERS, turnServers: TURN_SERVERS });
});

// ----- Socket.io (signaling) -----

io.on('connection', (socket) => {
    socket.on('entrarComoCamera', ({ token, cameraId, nome, time }) => {
        const sessao = sessionStore.obterSessao(token);

        if (!sessao || !sessao.ativa || sessionStore.sessaoExpirada(sessao)) {
            socket.emit('erro', 'Sessão inválida, encerrada ou expirada.');
            return;
        }

        socket.join(grupoSessao(token));
        socket.cameraId = cameraId;
        const eraCameraAtiva = sessao.cameraAtivaId;
        sessionStore.adicionarCamera(token, cameraId, socket.id, nome, time);
        db.registrarCamera(token, cameraId, nome).catch((erro) => console.error('[db] Falha ao registrar câmera:', erro));

        console.log(`[Câmera conectada] token=${token} cameraId=${cameraId} socketId=${socket.id}`);

        socket.emit('cameraConfirmada', token);

        const cam = sessionStore.obterCameraPorCameraId(token, cameraId);

        // Avisa cada dashboard já conectado para que crie um card, e pede à própria
        // câmera que envie o Offer a cada um deles — a câmera é quem inicia o Offer
        // (papel mantido do antigo broadcaster, só troca o destinatário de
        // "espectador" para "dashboard").
        sessionStore.listarDashboards(token).forEach((dashboardSocketId) => {
            io.to(dashboardSocketId).emit('novaCameraConectada', { socketId: socket.id, cameraId, nome: cam.nome, time: cam.time });
            socket.emit('novoEspectador', dashboardSocketId);
        });

        // Primeira câmera a conectar na sessão assume automaticamente o papel de
        // câmera ativa (exibida no link único de visualização) — avisa dashboards
        // e qualquer observador que já esteja no link único aguardando uma câmera.
        if (!eraCameraAtiva && sessao.cameraAtivaId === cameraId) {
            io.to(grupoSessao(token)).emit('cameraAtivaAtualizada', { cameraId });
        }
    });

    socket.on('entrarComoObservador', ({ token, cameraId }) => {
        const sessao = sessionStore.obterSessao(token);

        if (!sessao || !sessao.ativa || sessionStore.sessaoExpirada(sessao)) {
            socket.emit('erro', 'Sessão não encontrada, encerrada ou expirada.');
            return;
        }

        // Sem cameraId explícito (link único de visualização): observa a câmera
        // atualmente selecionada como ativa na sessão pelo dashboard.
        const cameraIdAlvo = cameraId || sessionStore.obterCameraAtiva(token)?.cameraId;
        const camera = cameraIdAlvo ? sessionStore.obterCameraPorCameraId(token, cameraIdAlvo) : null;
        if (!camera) {
            socket.emit('erro', 'Nenhuma câmera conectada no momento.');
            return;
        }

        socket.join(grupoSessao(token));
        socket.token = token;
        socket.seguindoCameraAtiva = !cameraId;
        socket.observandoCameraId = cameraIdAlvo;
        sessionStore.adicionarObservador(token, cameraIdAlvo, socket.id);

        console.log(`[Observador conectado] token=${token} cameraId=${cameraIdAlvo} socketId=${socket.id}`);

        // Pede à câmera específica que envie o Offer a este observador.
        io.to(camera.socketId).emit('novoEspectador', socket.id);
        socket.emit('cameraAtivaAtualizada', { cameraId: cameraIdAlvo });

        if (camera.vertical !== null) {
            socket.emit('orientacaoCameraAtualizada', { cameraId: cameraIdAlvo, vertical: camera.vertical, invertido: camera.invertido });
        }

        notificarContagemObservadores(token, cameraIdAlvo);
    });

    // Disparado pelo dashboard ao clicar em "Selecionar" num card: define qual
    // câmera o link único de visualização (watch.html?token=...) exibe, e migra
    // todos os observadores que estavam seguindo a câmera ativa (sem cameraId
    // fixo na URL) para a nova câmera. cameraId null deselecionar — clicar de
    // novo na câmera já ativa a tira da seleção, mesmo sem outra câmera para
    // assumir o lugar, deixando o link único sem câmera até uma nova escolha.
    socket.on('selecionarCameraAtiva', ({ token, cameraId }) => {
        const sessao = sessionStore.definirCameraAtiva(token, cameraId);
        if (!sessao) {
            socket.emit('erro', 'Câmera inválida ou não conectada.');
            return;
        }

        const camera = cameraId ? sessionStore.obterCameraPorCameraId(token, cameraId) : null;

        io.in(grupoSessao(token)).fetchSockets().then((sockets) => {
            sockets.forEach((s) => {
                if (!s.seguindoCameraAtiva || s.observandoCameraId === cameraId) return;

                sessionStore.removerObservadorPorSocketId(s.id);
                s.observandoCameraId = cameraId;
                if (cameraId) sessionStore.adicionarObservador(token, cameraId, s.id);

                s.emit('cameraAtivaAtualizada', { cameraId });
                if (camera) {
                    io.to(camera.socketId).emit('novoEspectador', s.id);
                    if (camera.vertical !== null) {
                        s.emit('orientacaoCameraAtualizada', { cameraId, vertical: camera.vertical, invertido: camera.invertido });
                    }
                }
            });

            if (cameraId) notificarContagemObservadores(token, cameraId);
        });

        sessionStore.listarDashboards(token).forEach((dashboardSocketId) => {
            io.to(dashboardSocketId).emit('cameraAtivaAtualizada', { cameraId });
        });

        // Avisa todas as câmeras da sessão (não só a que virou ativa) para que
        // cada uma saiba se deve mostrar ou esconder o banner "no ar" — a que
        // perdeu a seleção também precisa escurecer o próprio indicador.
        sessionStore.listarCameras(token).forEach((cam) => {
            io.to(cam.socketId).emit('cameraAtivaAtualizada', { cameraId });
        });
    });

    socket.on('entrarComoDashboard', (token) => {
        const sessao = sessionStore.obterSessao(token);

        if (!sessao || !sessao.ativa || sessionStore.sessaoExpirada(sessao)) {
            socket.emit('erro', 'Sessão não encontrada, encerrada ou expirada.');
            return;
        }

        socket.join(grupoSessao(token));
        sessionStore.adicionarDashboard(token, socket.id);

        const camerasAtivas = sessionStore.listarCameras(token);
        console.log(`[Dashboard conectado] token=${token} socketId=${socket.id} cameras=${camerasAtivas.length}`);

        // Informa as câmeras já online (para reconstruir os cards e seus links de
        // visualização) e pede a cada uma que (re)envie Offer a este dashboard —
        // cobre o caso de o dashboard ter recarregado a página com câmeras já ativas.
        camerasAtivas.forEach((cam) => {
            socket.emit('novaCameraConectada', { socketId: cam.socketId, cameraId: cam.cameraId, nome: cam.nome, time: cam.time });
            io.to(cam.socketId).emit('novoEspectador', socket.id);

            const quantidade = sessionStore.contarObservadores(token, cam.cameraId);
            socket.emit('contagemObservadoresAtualizada', { cameraId: cam.cameraId, quantidade });

            if (cam.vertical !== null) {
                socket.emit('orientacaoCameraAtualizada', { cameraId: cam.cameraId, vertical: cam.vertical, invertido: cam.invertido });
            }

            if (cam.silenciada) {
                socket.emit('cameraSilenciadaAtualizada', { cameraId: cam.cameraId, silenciada: true });
            }
        });

        const cameraAtiva = sessionStore.obterCameraAtiva(token);
        if (cameraAtiva) {
            socket.emit('cameraAtivaAtualizada', { cameraId: cameraAtiva.cameraId });
        }
    });

    socket.on('enviarOffer', ({ targetSocketId, sdpOffer }) => {
        io.to(targetSocketId).emit('receberOffer', { senderSocketId: socket.id, sdpOffer });
    });

    socket.on('enviarAnswer', ({ targetSocketId, sdpAnswer }) => {
        io.to(targetSocketId).emit('receberAnswer', { senderSocketId: socket.id, sdpAnswer });
    });

    socket.on('enviarIceCandidate', ({ targetSocketId, candidate }) => {
        io.to(targetSocketId).emit('receberIceCandidate', { senderSocketId: socket.id, candidate });
    });

    socket.on('heartbeat', (token) => {
        sessionStore.atualizarAtividade(token);
    });

    socket.on('orientacaoAtualizada', ({ token, vertical, invertido }) => {
        sessionStore.atualizarOrientacaoCamera(token, socket.cameraId, vertical, invertido);
        io.to(grupoSessao(token)).emit('orientacaoCameraAtualizada', { cameraId: socket.cameraId, vertical, invertido });
    });

    // Disparado pelo dashboard ao clicar em "Silenciar" num card: pede à
    // própria câmera que desabilite a track de áudio local, o que interrompe
    // o envio de áudio para TODOS os peers já conectados (dashboard, link
    // único e qualquer link individual) sem precisar renegociar cada
    // RTCPeerConnection individualmente.
    socket.on('alternarSilenciarCamera', ({ token, cameraId }) => {
        const novoEstado = sessionStore.alternarSilenciada(token, cameraId);
        if (novoEstado === null) {
            socket.emit('erro', 'Esta câmera não está conectada no momento.');
            return;
        }

        const camera = sessionStore.obterCameraPorCameraId(token, cameraId);
        io.to(camera.socketId).emit('definirSilenciada', novoEstado);
        io.to(grupoSessao(token)).emit('cameraSilenciadaAtualizada', { cameraId, silenciada: novoEstado });
    });

    // Chat individual entre o dashboard e cada câmera, isolado por cameraId —
    // mensagens de uma câmera nunca aparecem na conversa de outra. Efêmero
    // (sem persistência em banco), como o resto do estado da sessão.
    socket.on('enviarMensagemChat', ({ token, cameraId, remetente, texto }) => {
        const textoLimpo = String(texto || '').trim().slice(0, 500);
        if (!textoLimpo) return;

        const mensagem = { cameraId, remetente, texto: textoLimpo, enviadaEm: Date.now() };

        if (remetente === 'dashboard') {
            const camera = sessionStore.obterCameraPorCameraId(token, cameraId);
            if (!camera) {
                socket.emit('erro', 'Esta câmera não está conectada no momento.');
                return;
            }
            io.to(camera.socketId).emit('mensagemChatRecebida', mensagem);
            // Ecoa para outras abas do dashboard na mesma sessão (ex: mais de
            // um monitor aberto), mas não de volta pro socket que enviou (já
            // renderizou a própria mensagem otimisticamente) nem para a
            // câmera (já recebeu acima, e o grupo da sessão inclui câmeras).
            sessionStore.listarDashboards(token)
                .filter((dashboardSocketId) => dashboardSocketId !== socket.id)
                .forEach((dashboardSocketId) => {
                    io.to(dashboardSocketId).emit('mensagemChatRecebida', mensagem);
                });
        } else {
            sessionStore.listarDashboards(token).forEach((dashboardSocketId) => {
                io.to(dashboardSocketId).emit('mensagemChatRecebida', mensagem);
            });
        }
    });

    socket.on('pararTransmissao', (token) => {
        const sessao = sessionStore.removerCameraPorSocketId(socket.id);
        if (sessao) {
            io.to(grupoSessao(sessao.token)).emit('cameraDesconectada', { socketId: socket.id, cameraId: socket.cameraId });
            io.to(grupoSessao(sessao.token)).emit('cameraAtivaAtualizada', { cameraId: sessao.cameraAtivaId });
        }
        socket.leave(grupoSessao(token));
    });

    // Disparado pelo dashboard ao clicar em "Desconectar" num card: encerra a
    // transmissão daquela câmera remotamente. O servidor avisa o socket da
    // própria câmera para que ela pare a captura local (em vez de só derrubar a
    // conexão), e já limpa o estado da sessão como se a câmera tivesse saído
    // por conta própria.
    socket.on('desconectarCamera', ({ token, cameraId }) => {
        const camera = sessionStore.obterCameraPorCameraId(token, cameraId);
        if (!camera) {
            socket.emit('erro', 'Esta câmera não está conectada no momento.');
            return;
        }

        io.to(camera.socketId).emit('forcarDesconexao');

        const sessao = sessionStore.removerCameraPorSocketId(camera.socketId);
        if (sessao) {
            io.to(grupoSessao(sessao.token)).emit('cameraDesconectada', { socketId: camera.socketId, cameraId });
            io.to(grupoSessao(sessao.token)).emit('cameraAtivaAtualizada', { cameraId: sessao.cameraAtivaId });
        }
    });

    socket.on('disconnect', () => {
        const sessaoComoCamera = sessionStore.removerCameraPorSocketId(socket.id);

        if (sessaoComoCamera) {
            io.to(grupoSessao(sessaoComoCamera.token)).emit('cameraDesconectada', { socketId: socket.id, cameraId: socket.cameraId });
            io.to(grupoSessao(sessaoComoCamera.token)).emit('cameraAtivaAtualizada', { cameraId: sessaoComoCamera.cameraAtivaId });
            console.log(`[Câmera desconectada] token=${sessaoComoCamera.token} cameraId=${socket.cameraId} socketId=${socket.id}`);
            return;
        }

        const removidoComoObservador = sessionStore.removerObservadorPorSocketId(socket.id);
        if (removidoComoObservador) {
            notificarContagemObservadores(removidoComoObservador.sessao.token, removidoComoObservador.cameraId);
            return;
        }

        sessionStore.removerDashboardPorSocketId(socket.id);
    });
});

// Limpeza periódica de sessões inativas/expiradas, equivalente ao SessionCleanupService original.
setInterval(() => {
    const encerradas = sessionStore.encerrarSessoesInativas();
    if (encerradas > 0) {
        console.log(`[Limpeza] ${encerradas} sessão(ões) encerrada(s) por inatividade/expiração.`);
    }
}, 60 * 1000);

httpServer.listen(PORT, () => {
    console.log(`SecurityCam signaling server rodando na porta ${PORT}`);
});
