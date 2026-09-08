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

// Rotas legadas do modelo anterior (múltiplas sessões, uma por link gerado
// sob demanda). O dashboard não as usa mais — ele sempre conecta ao link
// único fixo via GET /api/link-unico, abaixo. Mantidas por compatibilidade/
// depuração manual.
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

// Token do link único fixo da aplicação: sempre o mesmo, para sempre, gerado
// uma única vez e persistido no Supabase (ver obterOuCriarTokenLinkUnico) —
// diferente de POST /api/sessions (que cria um token novo a cada chamada),
// esta rota é idempotente: qualquer dashboard, em qualquer navegador ou
// dispositivo, que a chame recebe o mesmo token, inclusive após restart do
// servidor.
app.get('/api/link-unico', async (_req, res) => {
    const token = await db.obterOuCriarTokenLinkUnico();
    if (!token) {
        return res.status(503).json({ erro: 'Persistência indisponível (Supabase não configurado ou inacessível).' });
    }

    // Garante que a sessão correspondente já existe em memória, para que
    // câmeras e observadores possam conectar imediatamente mesmo que o
    // servidor tenha acabado de subir e nenhuma requisição anterior tenha
    // "tocado" nesse token ainda.
    sessionStore.obterSessao(token);

    res.json({ token, iceServers: { stunServers: STUN_SERVERS, turnServers: TURN_SERVERS } });
});

// Token do link de CÂMERA (camera.html?token=...) — separado do link único de
// visualização acima. Autoriza a conexão de uma câmera à mesma sessão fixa,
// mas pode ser regenerado a qualquer momento (revogar o acesso de quem já tem
// o link, ex: trocar de evento) sem afetar o link de visualização, que
// continua sempre o mesmo.
app.get('/api/link-camera', async (_req, res) => {
    const token = await db.obterOuCriarTokenLinkCamera();
    if (!token) {
        return res.status(503).json({ erro: 'Persistência indisponível (Supabase não configurado ou inacessível).' });
    }
    res.json({ token });
});

app.post('/api/link-camera/regenerar', async (_req, res) => {
    const token = await db.regenerarTokenLinkCamera();
    if (!token) {
        return res.status(503).json({ erro: 'Persistência indisponível (Supabase não configurado ou inacessível).' });
    }
    res.json({ token });
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
    // O token que camera.html envia é o token de CÂMERA (regenerável,
    // separado do token de sessão/visualização) — precisa bater com o valor
    // atual salvo para autorizar a entrada. Se bater, todo o resto do fluxo
    // (sessão, sala, cards) usa o token de sessão fixo internamente, nunca o
    // token de câmera recebido, já que é só uma chave de autorização, não o
    // identificador real da sessão.
    // Nota: regenerar o token de câmera não derruba quem já está transmitindo
    // no momento — só impede uma NOVA entrada (ou reconexão futura) com o
    // link antigo. Isso é intencional: evita cortar abruptamente uma
    // transmissão em andamento só porque o admin gerou um link novo para
    // outra pessoa.
    socket.on('entrarComoCamera', async ({ token: tokenCamera, cameraId, nome, time }) => {
        const tokenCameraAtual = await db.obterOuCriarTokenLinkCamera();
        if (!tokenCameraAtual || tokenCamera !== tokenCameraAtual) {
            socket.emit('erro', 'Este link de câmera não é mais válido. Peça um novo link para quem está administrando a transmissão.');
            return;
        }

        const token = await db.obterOuCriarTokenLinkUnico();
        const sessao = token ? sessionStore.obterSessao(token) : null;

        if (!sessao || !sessao.ativa || sessionStore.sessaoExpirada(sessao)) {
            socket.emit('erro', 'Sessão inválida, encerrada ou expirada.');
            return;
        }

        socket.join(grupoSessao(token));
        socket.cameraId = cameraId;
        // Guardado no próprio socket para que os demais eventos emitidos por
        // esta câmera (orientacaoAtualizada, heartbeat, atualizarDadosTorcedor,
        // pararTransmissao, chat) usem o token de SESSÃO real, nunca o token de
        // câmera que veio no payload de entrarComoCamera — o token de câmera é
        // só uma credencial de entrada, não o identificador da sessão, e pode
        // já ter sido regenerado por outra requisição no meio da transmissão.
        socket.token = token;
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
        if (camera.rotacaoManual) {
            socket.emit('rotacaoCameraAtualizada', { cameraId: cameraIdAlvo, rotacaoManual: camera.rotacaoManual });
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
        // Um dashboard aberto (só exibindo o QR/link, sem câmera ainda) não
        // gerava nenhuma atividade antes — a sessão podia expirar por
        // inatividade (5min) mesmo com o dashboard visível, fazendo a câmera
        // conectar numa sessão recriada do zero que o dashboard não via mais.
        sessionStore.atualizarAtividade(token);

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

            if (cam.rotacaoManual) {
                socket.emit('rotacaoCameraAtualizada', { cameraId: cam.cameraId, rotacaoManual: cam.rotacaoManual });
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

    // Emitido tanto pela câmera quanto pelo dashboard. O dashboard manda o
    // token de sessão real no payload (correto, é o que ele conhece); a
    // câmera manda o token de CÂMERA (usado só para autorizar a entrada) —
    // por isso, se este socket já se autenticou como câmera, ignoramos o
    // payload e usamos socket.token (o token de sessão real, guardado em
    // entrarComoCamera), que é sempre a fonte confiável.
    socket.on('heartbeat', (token) => {
        sessionStore.atualizarAtividade(socket.token || token);
    });

    socket.on('orientacaoAtualizada', ({ vertical, invertido }) => {
        const token = socket.token;
        if (!token) return;
        sessionStore.atualizarOrientacaoCamera(token, socket.cameraId, vertical, invertido);
        io.to(grupoSessao(token)).emit('orientacaoCameraAtualizada', { cameraId: socket.cameraId, vertical, invertido });
    });

    // Disparado pela câmera enquanto a pessoa digita nome/time (com debounce
    // no cliente) — sem isso, esses dados só chegavam ao dashboard no momento
    // em que a transmissão era iniciada, então preenchê-los depois de já estar
    // transmitindo nunca aparecia para quem está assistindo.
    socket.on('atualizarDadosTorcedor', ({ nome, time }) => {
        const token = socket.token;
        if (!token || !socket.cameraId) return;
        const nomeLimpo = String(nome || '').trim().slice(0, 60) || null;
        const timeLimpo = String(time || '').trim().slice(0, 60) || null;

        const cam = sessionStore.atualizarDadosTorcedor(token, socket.cameraId, nomeLimpo, timeLimpo);
        if (!cam) return;

        db.registrarCamera(token, socket.cameraId, nomeLimpo).catch((erro) => console.error('[db] Falha ao atualizar câmera:', erro));

        sessionStore.listarDashboards(token).forEach((dashboardSocketId) => {
            io.to(dashboardSocketId).emit('dadosTorcedorAtualizados', { cameraId: socket.cameraId, nome: nomeLimpo, time: timeLimpo });
        });
    });

    // Disparado pelo botão "girar" no dashboard — propaga a rotação manual
    // (independente da orientação automática) para quem está assistindo
    // (watch.html) e para outros dashboards abertos na mesma sessão.
    socket.on('girarCamera', ({ token, cameraId }) => {
        const cam = sessionStore.obterCameraPorCameraId(token, cameraId);
        if (!cam) return;
        const novoAngulo = sessionStore.atualizarRotacaoManual(token, cameraId, cam.rotacaoManual + 90);
        io.to(grupoSessao(token)).emit('rotacaoCameraAtualizada', { cameraId, rotacaoManual: novoAngulo });
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
    // Igual ao heartbeat acima: a câmera manda o token de câmera no payload,
    // então usamos socket.token (token de sessão real) quando disponível.
    socket.on('enviarMensagemChat', ({ token: tokenPayload, cameraId, remetente, texto }) => {
        const token = socket.token || tokenPayload;
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

    // token recebido no payload é o token de câmera; socket.token (setado em
    // entrarComoCamera) é o token de sessão real usado para sair da sala.
    socket.on('pararTransmissao', () => {
        const sessao = sessionStore.removerCameraPorSocketId(socket.id);
        if (sessao) {
            io.to(grupoSessao(sessao.token)).emit('cameraDesconectada', { socketId: socket.id, cameraId: socket.cameraId });
            io.to(grupoSessao(sessao.token)).emit('cameraAtivaAtualizada', { cameraId: sessao.cameraAtivaId });
        }
        if (socket.token) socket.leave(grupoSessao(socket.token));
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
