// index.js
// Servidor de signaling WebRTC do SecurityCam: API REST para criar/consultar sessões
// e Socket.io para a troca de Offer/Answer/ICE entre transmissor e espectadores.
// O frontend estático (HTML/CSS/JS) é hospedado separadamente na Vercel; este
// servidor só cuida da negociação da conexão peer-to-peer, nunca do vídeo em si.

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const sessionStore = require('./sessionStore');

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

app.get('/api/sessions/:token/status', (req, res) => {
    const sessao = sessionStore.obterSessao(req.params.token);
    if (!sessao) {
        return res.status(404).json({ erro: 'Sessão não encontrada.' });
    }

    res.json({
        token: sessao.token,
        ativa: sessao.ativa,
        expirada: sessionStore.sessaoExpirada(sessao),
        quantidadeEspectadores: sessao.espectadores.size,
        ultimaAtividade: sessao.ultimaAtividade
    });
});

app.get('/api/ice-config', (_req, res) => {
    res.json({ stunServers: STUN_SERVERS, turnServers: TURN_SERVERS });
});

// ----- Socket.io (signaling) -----

io.on('connection', (socket) => {
    socket.on('entrarComoBroadcaster', (token) => {
        const sessao = sessionStore.obterSessao(token);

        if (!sessao || !sessao.ativa) {
            socket.emit('erro', 'Sessão inválida ou inativa.');
            return;
        }

        socket.join(grupoSessao(token));
        sessionStore.definirBroadcaster(token, socket.id);

        console.log(`[Broadcaster conectado] token=${token} socketId=${socket.id}`);

        socket.emit('broadcasterConfirmado', token);
        io.to(grupoSessao(token)).emit('broadcasterOnline');
    });

    socket.on('entrarComoEspectador', (token) => {
        const sessao = sessionStore.obterSessao(token);

        if (!sessao || !sessao.ativa || sessionStore.sessaoExpirada(sessao)) {
            socket.emit('erro', 'Transmissão não encontrada, encerrada ou expirada.');
            return;
        }

        socket.join(grupoSessao(token));
        sessionStore.adicionarEspectador(token, socket.id);

        console.log(`[Espectador conectado] token=${token} socketId=${socket.id}`);

        if (sessao.broadcasterSocketId) {
            io.to(sessao.broadcasterSocketId).emit('novoEspectador', socket.id);
        } else {
            socket.emit('broadcasterOffline');
        }

        io.to(grupoSessao(token)).emit('atualizarContagemEspectadores', sessao.espectadores.size);
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

    socket.on('pararTransmissao', (token) => {
        sessionStore.encerrarSessao(token);
        io.to(grupoSessao(token)).emit('transmissaoEncerrada');
        socket.leave(grupoSessao(token));
    });

    socket.on('disconnect', () => {
        const sessaoComoBroadcaster = sessionStore.removerBroadcasterPorSocketId(socket.id);

        if (sessaoComoBroadcaster) {
            io.to(grupoSessao(sessaoComoBroadcaster.token)).emit('broadcasterOffline');
            console.log(`[Broadcaster desconectado] token=${sessaoComoBroadcaster.token}`);
            return;
        }

        const sessaoComoEspectador = sessionStore.removerEspectadorPorSocketId(socket.id);
        if (sessaoComoEspectador) {
            io.to(grupoSessao(sessaoComoEspectador.token)).emit(
                'atualizarContagemEspectadores',
                sessaoComoEspectador.espectadores.size
            );
        }
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
