# SecurityCam

Aplicação que transforma um smartphone em uma câmera de segurança acessível pela
internet via link compartilhável, usando WebRTC para vídeo em tempo real.

## Arquitetura

O projeto é dividido em duas partes com deploy independente, porque a Vercel
(usada para o frontend) só executa funções serverless e não suporta WebSocket
persistente — necessário para o signaling do WebRTC.

```
/server   -> Node.js + Express + Socket.io: signaling (Offer/Answer/ICE) e API REST
/public   -> Frontend estático (HTML/CSS/JS puro): hospedado na Vercel
```

### Fluxo de funcionamento

1. Usuário acessa `index.html` e clica em "Iniciar Nova Transmissão" — isso chama
   `POST /api/sessions` no servidor de signaling, que gera um token aleatório.
2. É redirecionado para `broadcaster.html?token=...` — a página solicita permissão
   de câmera e conecta ao servidor via Socket.io.
3. Ao clicar em "Iniciar Transmissão", a câmera traseira é ativada e o transmissor
   entra na "sala" da sessão (`entrarComoBroadcaster`).
4. Ao clicar em "Compartilhar", o link `viewer.html?token=...` é exibido/copiado.
5. Cada espectador que abre esse link entra na mesma sala; o transmissor recebe
   `novoEspectador` e cria uma `RTCPeerConnection` dedicada, enviando um SDP Offer.
6. O espectador responde com SDP Answer; ambos trocam ICE Candidates via Socket.io
   até a conexão peer-to-peer ser estabelecida.
7. Vídeo flui diretamente entre os pares (P2P) usando STUN para resolução de NAT,
   com fallback para TURN quando configurado.

## Executando localmente

### 1. Servidor de signaling

```bash
cd server
npm install
npm start
```

Sobe em `http://localhost:4000` por padrão (configurável via variável `PORT`).

### 2. Frontend estático

Em outro terminal:

```bash
cd public
npx serve -l 3000 .
```

Edite `public/config.js` se o servidor não estiver em `http://localhost:4000`:

```js
window.SECURITYCAM_SERVER_URL = 'http://localhost:4000';
```

Acesse `http://localhost:3000` no navegador.

> Para testar a câmera de um celular na mesma rede, ambos (frontend e servidor)
> precisam estar acessíveis por HTTPS ou seu IP local — `getUserMedia` exige
> contexto seguro fora de `localhost`. Para isso, publique nas plataformas abaixo
> (que já fornecem HTTPS automaticamente) em vez de testar via IP local puro.

## Publicando em produção

### Frontend na Vercel

1. Crie um projeto na [Vercel](https://vercel.com) apontando para este repositório.
2. Em **Settings → General**, defina o **Root Directory** como a raiz do repo (o
   `vercel.json` já configura `outputDirectory: public`).
3. Antes do deploy, edite `public/config.js` com a URL pública do servidor de
   signaling (veja seção seguinte):

   ```js
   window.SECURITYCAM_SERVER_URL = 'https://seu-servidor-signaling.up.railway.app';
   ```
4. Faça o deploy. A Vercel fornece um domínio com HTTPS automaticamente.

### Servidor de signaling no Railway (ou Render)

A Vercel **não** executa o servidor Node/Socket.io — ele precisa de um processo
sempre ativo, o que serverless não oferece. Use o [Railway](https://railway.app)
ou [Render](https://render.com), ambos com free tier:

1. Crie um novo projeto apontando para este repositório.
2. Defina o **Root Directory** como `server`.
3. Build command: `npm install`. Start command: `npm start`.
4. Variáveis de ambiente opcionais:
   - `ALLOWED_ORIGINS`: domínio da Vercel, ex. `https://seu-app.vercel.app` (separe por vírgula se houver mais de um). Sem essa variável, qualquer origem é aceita.
   - `STUN_SERVERS`: lista de STUN separada por vírgula (tem um padrão público já configurado).
   - `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`: configure se precisar de TURN (veja seção coturn abaixo).
5. Gere o domínio público (HTTPS automático) nas configurações de rede do serviço.
6. Copie essa URL para `public/config.js` antes do deploy do frontend na Vercel.

## Configurando STUN/TURN com coturn

O STUN público do Google já vem configurado e é suficiente para a maioria das
redes domésticas. Em redes com NAT simétrico ou firewalls restritivos, pode ser
necessário um servidor **TURN**, que retransmite a mídia.

### 1. Instalar o coturn em uma VPS Linux

```bash
sudo apt-get install -y coturn
```

### 2. Configurar `/etc/turnserver.conf`

```ini
listening-port=3478
tls-listening-port=5349
external-ip=SEU_IP_PUBLICO
realm=seu-dominio.com
user=usuario_turn:senha_turn
cert=/etc/letsencrypt/live/seu-dominio.com/fullchain.pem
pkey=/etc/letsencrypt/live/seu-dominio.com/privkey.pem
min-port=49152
max-port=65535
lt-cred-mech
fingerprint
```

### 3. Abrir as portas no firewall

```bash
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 5349/udp
sudo ufw allow 49152:65535/udp
sudo systemctl enable coturn
sudo systemctl restart coturn
```

### 4. Configurar no servidor de signaling

Defina as variáveis de ambiente no Railway/Render:

```
TURN_URL=turn:seu-dominio.com:3478
TURN_USERNAME=usuario_turn
TURN_CREDENTIAL=senha_turn
```

## Segurança

- Tokens de sessão gerados com `crypto.randomBytes` (24 bytes) — URLs praticamente impossíveis de adivinhar.
- CORS restrito por origem configurável via `ALLOWED_ORIGINS`.
- HTTPS obrigatório em produção (fornecido automaticamente pela Vercel e Railway/Render).
- Sessões em memória, sem persistência em disco — encerradas automaticamente após 5 minutos de inatividade ou na expiração configurada.

## Limitações conhecidas

- Sessões vivem apenas enquanto o processo do servidor de signaling está ativo; reinícios do servidor encerram todas as transmissões em andamento (aceitável, dado que são efêmeras por natureza).
- Para uso em produção em larga escala (centenas de espectadores por transmissão), considere um SFU (ex: mediasoup, Janus) em vez de várias conexões P2P 1:1 partindo do celular, que tem CPU/banda de upload limitadas.
