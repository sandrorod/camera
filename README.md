# SecurityCam

Aplicação ASP.NET Core 8 (C#) que transforma um smartphone em uma câmera de segurança
acessível pela internet, usando WebRTC para transmissão de vídeo em tempo real e
SignalR para o signaling (negociação da conexão peer-to-peer).

## Arquitetura

```
/Controllers        -> StreamController (páginas + API REST)
/Hubs               -> CameraHub (signaling SignalR: Offer/Answer/ICE)
/Services           -> StreamSessionService, SessionCleanupService, WebRtcConfigService
/Models             -> SessionModel, ViewerModel, ConnectionLogModel (entidades EF Core)
/ViewModels         -> DTOs para as Views e para a API
/Data               -> SecurityCamDbContext (EF Core + SQLite)
/Views              -> Stream/Index (criar transmissão), Stream/Broadcaster, Stream/Viewer
/wwwroot/js         -> webrtc-common.js, broadcaster.js, viewer.js
/wwwroot/css        -> site.css
```

### Fluxo de funcionamento

1. Usuário acessa `/` no celular e clica em "Iniciar Nova Transmissão" (com senha/expiração opcionais).
2. É redirecionado para `/stream/broadcaster/{token}` — a página solicita permissão de câmera.
3. Ao clicar em "Iniciar Transmissão", a câmera traseira é ativada e a página se conecta ao `CameraHub` via SignalR.
4. Ao clicar em "Compartilhar", o link `/stream/viewer/{token}` é exibido/copiado.
5. Cada espectador que abre esse link entra no mesmo grupo SignalR da sessão; o transmissor recebe um evento `NovoEspectador` e cria uma `RTCPeerConnection` dedicada, enviando um SDP Offer.
6. O espectador responde com SDP Answer; ambos trocam ICE Candidates via SignalR até a conexão peer-to-peer ser estabelecida.
7. Vídeo/áudio fluem diretamente entre os pares (P2P) usando STUN para resolução de NAT, com fallback para TURN quando configurado (redes restritivas/simétricas).

## Pré-requisitos

- Visual Studio 2022 (17.8+) com workload **ASP.NET e desenvolvimento web**
- .NET 8 SDK
- Não é necessário instalar SQLite manualmente — o driver embarcado (`Microsoft.EntityFrameworkCore.Sqlite`) cuida disso.

## Executando localmente (Visual Studio 2022)

1. Abra `SecurityCam.csproj` no Visual Studio 2022 (ou a pasta inteira via "Open Folder").
2. O Visual Studio deve restaurar os pacotes NuGet automaticamente. Se não restaurar a biblioteca cliente do SignalR (`wwwroot/lib/signalr/signalr.min.js`), clique com o botão direito em `libman.json` → **Restore Client-Side Libraries** (o arquivo já vem incluído no projeto, então isso é apenas um fallback).
3. Selecione o profile **https** no dropdown de execução (necessário pois `getUserMedia` exige contexto seguro).
4. Pressione **F5**. O navegador abrirá em `https://localhost:7253`.
5. Para testar a partir do celular **na mesma rede local**, descubra o IP da máquina (`ipconfig`/`ifconfig`) e acesse `https://SEU_IP:7253` do celular — você precisará aceitar o certificado de desenvolvimento autoassinado (ou confiar nele previamente com `dotnet dev-certs https --trust` na máquina de desenvolvimento, mas isso não cobre o certificado no celular: para testes reais no celular, prefira publicar em um servidor com HTTPS válido, conforme a seção de VPS abaixo).

### Gerando a migration inicial (opcional)

O projeto cria o banco automaticamente via `EnsureCreated()` na primeira execução, então
funciona sem migrations. Caso prefira usar migrations versionadas (recomendado para evolução do schema):

```bash
dotnet tool install --global dotnet-ef
dotnet ef migrations add InitialCreate
dotnet ef database update
```

Depois disso, o `Program.cs` detecta migrations existentes e passa a usar `Database.Migrate()` automaticamente.

## Publicando em VPS Linux (Ubuntu 22.04+)

### 1. Instalar o .NET 8 Runtime no servidor

```bash
sudo apt-get update
sudo apt-get install -y aspnetcore-runtime-8.0
```

### 2. Publicar a aplicação (na máquina de desenvolvimento)

```bash
dotnet publish -c Release -o ./publish
```

Copie a pasta `publish` para o servidor (ex: via `scp`):

```bash
scp -r ./publish usuario@SEU_SERVIDOR:/var/www/securitycam
```

### 3. Criar um serviço systemd

Crie `/etc/systemd/system/securitycam.service`:

```ini
[Unit]
Description=SecurityCam ASP.NET Core App
After=network.target

[Service]
WorkingDirectory=/var/www/securitycam
ExecStart=/usr/bin/dotnet /var/www/securitycam/SecurityCam.dll
Restart=always
RestartSec=10
KillSignal=SIGINT
SyslogIdentifier=securitycam
User=www-data
Environment=ASPNETCORE_ENVIRONMENT=Production
Environment=ASPNETCORE_URLS=http://localhost:5000

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable securitycam
sudo systemctl start securitycam
sudo systemctl status securitycam
```

### 4. Configurar Nginx como proxy reverso

```bash
sudo apt-get install -y nginx
```

Crie `/etc/nginx/sites-available/securitycam`:

```nginx
server {
    listen 80;
    server_name seu-dominio.com;

    location / {
        proxy_pass         http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # SignalR usa WebSockets; timeouts maiores evitam desconexões em conexões longas.
        proxy_read_timeout 100s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/securitycam /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

## Configurando HTTPS com Let's Encrypt

HTTPS é **obrigatório** para que `getUserMedia` (acesso à câmera) funcione fora de `localhost`.

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d seu-dominio.com
```

O Certbot configura automaticamente o bloco `server { listen 443 ssl; }` no Nginx e
agenda a renovação automática. Verifique o cron/timer:

```bash
sudo systemctl status certbot.timer
```

Depois de emitido o certificado, atualize `appsettings.Production.json` (crie se não existir)
para forçar o domínio correto em `AllowedHosts` e nas origens de CORS, se necessário.

## Configurando STUN/TURN com coturn

O STUN público do Google (`stun:stun.l.google.com:19302`) já vem configurado em
`appsettings.json` e é suficiente para a maioria das redes domésticas. Porém, em redes
com NAT simétrico ou firewalls restritivos (comum em redes corporativas/móveis), a conexão
P2P pode falhar — nesse caso é necessário um servidor **TURN**, que retransmite a mídia.

### 1. Instalar o coturn no servidor (mesma VPS ou outra)

```bash
sudo apt-get install -y coturn
```

### 2. Habilitar o serviço

Edite `/etc/default/coturn` e descomente:

```
TURNSERVER_ENABLED=1
```

### 3. Configurar `/etc/turnserver.conf`

```ini
listening-port=3478
tls-listening-port=5349

# Substitua pelo IP público do seu servidor
external-ip=SEU_IP_PUBLICO

realm=seu-dominio.com
server-name=seu-dominio.com

# Credenciais de autenticação (use senhas fortes em produção)
user=usuario_turn:senha_turn

# Certificados (reaproveite os emitidos pelo Let's Encrypt)
cert=/etc/letsencrypt/live/seu-dominio.com/fullchain.pem
pkey=/etc/letsencrypt/live/seu-dominio.com/privkey.pem

# Restringe o range de portas de relay (ajuste o firewall/Security Group de acordo)
min-port=49152
max-port=65535

log-file=/var/log/turnserver.log
no-cli
fingerprint
lt-cred-mech
```

### 4. Abrir as portas necessárias no firewall

```bash
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 5349/udp
sudo ufw allow 49152:65535/udp
```

### 5. Iniciar o coturn

```bash
sudo systemctl enable coturn
sudo systemctl restart coturn
sudo systemctl status coturn
```

### 6. Apontar a aplicação para o TURN

Em `appsettings.json` (ou `appsettings.Production.json`), atualize:

```json
"WebRtc": {
  "StunServers": [
    "stun:stun.l.google.com:19302"
  ],
  "TurnServers": [
    {
      "Urls": "turn:seu-dominio.com:3478",
      "Username": "usuario_turn",
      "Credential": "senha_turn"
    },
    {
      "Urls": "turns:seu-dominio.com:5349",
      "Username": "usuario_turn",
      "Credential": "senha_turn"
    }
  ]
}
```

A aplicação injeta automaticamente esses servidores na configuração ICE de cada
`RTCPeerConnection`, tanto no transmissor quanto no espectador (veja `webrtc-common.js`,
função `montarIceServers`).

## Segurança implementada

- Tokens de sessão gerados com `RandomNumberGenerator` (criptograficamente seguro), 24 bytes → URLs praticamente impossíveis de adivinhar.
- Senhas de transmissão armazenadas como hash PBKDF2-SHA256 (100.000 iterações), nunca em texto puro.
- Comparação de hash em tempo constante (`CryptographicOperations.FixedTimeEquals`) para evitar timing attacks.
- HTTPS obrigatório via `UseHttpsRedirection` + `UseHsts` em produção.
- Expiração opcional de sessões por tempo, e encerramento automático por inatividade (5 minutos sem heartbeat), executado pelo `SessionCleanupService` em background.
- CORS configurável por origem permitida (evita que qualquer site faça requisições à API/Hub).
- Logs estruturados (Serilog) de todos os eventos de conexão (`ConnectionLogs`), incluindo tentativas de senha inválida.

## Banco de dados

SQLite, com as tabelas:

- **Sessions** — Id, Token, DataCriacao, DataUltimaAtividade, SenhaHash, Ativa, QuantidadeEspectadores, DataExpiracao, BroadcasterConnectionId
- **Viewers** — Id, SessionId, ConnectionId, EnderecoIp, DataConexao, DataDesconexao, Conectado
- **ConnectionLogs** — Id, SessionId, TipoEvento, ConnectionId, EnderecoIp, Detalhes, DataEvento

## Limitações conhecidas / próximos passos sugeridos

- O `BroadcasterConnectionId` fica vinculado a uma única aba/dispositivo transmissor por sessão; reabrir a página gera uma nova conexão SignalR (o servidor substitui o `ConnectionId` anterior).
- Para uso em produção em larga escala (centenas de espectadores por transmissão), considere um SFU (ex: mediasoup, Janus) em vez de várias conexões P2P 1:1 partindo do celular, que tem CPU/banda de upload limitadas.
