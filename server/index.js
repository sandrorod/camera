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

app.post('/api/sessions', (req, res) => {
    const { expiracaoMinutos } = req.body || {};
    const sessao = sessionStore.criarSessao(expiracaoMinutos);

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
    socket.on('entrarComoCamera', ({ token, cameraId }) => {
        const sessao = sessionStore.obterSessao(token);

        if (!sessao || !sessao.ativa || sessionStore.sessaoExpirada(sessao)) {
            socket.emit('erro', 'Sessão inválida, encerrada ou expirada.');
            return;
        }

        socket.join(grupoSessao(token));
        socket.cameraId = cameraId;
        sessionStore.adicionarCamera(token, cameraId, socket.id);
        db.registrarCamera(token, cameraId, null).catch((erro) => console.error('[db] Falha ao registrar câmera:', erro));

        console.log(`[Câmera conectada] token=${token} cameraId=${cameraId} socketId=${socket.id}`);

        socket.emit('cameraConfirmada', token);

        // Avisa cada dashboard já conectado para que crie um card, e pede à própria
        // câmera que envie o Offer a cada um deles — a câmera é quem inicia o Offer
        // (papel mantido do antigo broadcaster, só troca o destinatário de
        // "espectador" para "dashboard").
        sessionStore.listarDashboards(token).forEach((dashboardSocketId) => {
            io.to(dashboardSocketId).emit('novaCameraConectada', { socketId: socket.id, cameraId });
            socket.emit('novoEspectador', dashboardSocketId);
        });
    });

    socket.on('entrarComoObservador', ({ token, cameraId }) => {
        const sessao = sessionStore.obterSessao(token);

        if (!sessao || !sessao.ativa || sessionStore.sessaoExpirada(sessao)) {
            socket.emit('erro', 'Sessão não encontrada, encerrada ou expirada.');
            return;
        }

        const camera = sessionStore.obterCameraPorCameraId(token, cameraId);
        if (!camera) {
            socket.emit('erro', 'Esta câmera não está conectada no momento.');
            return;
        }

        socket.join(grupoSessao(token));
        socket.token = token;
        socket.observandoCameraId = cameraId;
        sessionStore.adicionarObservador(token, cameraId, socket.id);

        console.log(`[Observador conectado] token=${token} cameraId=${cameraId} socketId=${socket.id}`);

        // Pede à câmera específica que envie o Offer a este observador.
        io.to(camera.socketId).emit('novoEspectador', socket.id);

        if (camera.vertical !== null) {
            socket.emit('orientacaoCameraAtualizada', { cameraId, vertical: camera.vertical });
        }

        notificarContagemObservadores(token, cameraId);
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
            socket.emit('novaCameraConectada', { socketId: cam.socketId, cameraId: cam.cameraId });
            io.to(cam.socketId).emit('novoEspectador', socket.id);

            const quantidade = sessionStore.contarObservadores(token, cam.cameraId);
            socket.emit('contagemObservadoresAtualizada', { cameraId: cam.cameraId, quantidade });

            if (cam.vertical !== null) {
                socket.emit('orientacaoCameraAtualizada', { cameraId: cam.cameraId, vertical: cam.vertical });
            }
        });
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

    socket.on('orientacaoAtualizada', ({ token, vertical }) => {
        sessionStore.atualizarOrientacaoCamera(token, socket.cameraId, vertical);
        io.to(grupoSessao(token)).emit('orientacaoCameraAtualizada', { cameraId: socket.cameraId, vertical });
    });

    socket.on('pararTransmissao', (token) => {
        const sessao = sessionStore.removerCameraPorSocketId(socket.id);
        if (sessao) {
            io.to(grupoSessao(sessao.token)).emit('cameraDesconectada', { socketId: socket.id, cameraId: socket.cameraId });
        }
        socket.leave(grupoSessao(token));
    });

    socket.on('disconnect', () => {
        const sessaoComoCamera = sessionStore.removerCameraPorSocketId(socket.id);

        if (sessaoComoCamera) {
            io.to(grupoSessao(sessaoComoCamera.token)).emit('cameraDesconectada', { socketId: socket.id, cameraId: socket.cameraId });
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
