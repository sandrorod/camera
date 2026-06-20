using Microsoft.AspNetCore.SignalR;
using SecurityCam.Models;
using SecurityCam.Services;

namespace SecurityCam.Hubs;

/// <summary>
/// Hub SignalR responsável pelo signaling WebRTC: troca de SDP Offer/Answer e
/// ICE Candidates entre o transmissor (broadcaster) e os espectadores (viewers).
/// O Hub não transporta vídeo/áudio — apenas a negociação inicial da conexão
/// peer-to-peer, que depois ocorre diretamente entre os pares (ou via TURN).
///
/// Cada sessão de transmissão é mapeada para um "grupo" SignalR cujo nome é o
/// próprio token da sessão, permitindo broadcast eficiente para N espectadores.
/// </summary>
public class CameraHub : Hub
{
    private readonly IStreamSessionService _sessionService;
    private readonly ILogger<CameraHub> _logger;

    public CameraHub(IStreamSessionService sessionService, ILogger<CameraHub> logger)
    {
        _sessionService = sessionService;
        _logger = logger;
    }

    /// <summary>
    /// Chamado pelo celular (transmissor) ao iniciar a transmissão.
    /// Associa a conexão atual ao token da sessão e entra no grupo SignalR correspondente.
    /// </summary>
    public async Task EntrarComoBroadcaster(string token)
    {
        var session = await _sessionService.ObterPorTokenAsync(token);
        if (session is null || !session.Ativa)
        {
            await Clients.Caller.SendAsync("Erro", "Sessão inválida ou inativa.");
            return;
        }

        await Groups.AddToGroupAsync(Context.ConnectionId, GrupoSessao(token));
        await _sessionService.DefinirBroadcasterAsync(token, Context.ConnectionId);

        _logger.LogInformation("Broadcaster conectado. Token={Token} ConnectionId={ConnectionId}", token, Context.ConnectionId);

        await Clients.Caller.SendAsync("BroadcasterConfirmado", token);

        // Notifica espectadores que já estavam aguardando que o transmissor está online
        await Clients.Group(GrupoSessao(token)).SendAsync("BroadcasterOnline");
    }

    /// <summary>
    /// Chamado pelo navegador do espectador ao abrir o link de visualização.
    /// Valida a sessão (incluindo senha, se houver) antes de admitir o espectador no grupo.
    /// </summary>
    public async Task EntrarComoEspectador(string token, string? senha)
    {
        var session = await _sessionService.ObterPorTokenAsync(token);

        if (session is null || !session.Ativa || session.Expirada)
        {
            await Clients.Caller.SendAsync("Erro", "Transmissão não encontrada, encerrada ou expirada.");
            return;
        }

        if (session.PossuiSenha)
        {
            var senhaValida = await _sessionService.ValidarSenhaAsync(token, senha ?? string.Empty);
            if (!senhaValida)
            {
                await Clients.Caller.SendAsync("SenhaInvalida");
                return;
            }
        }

        var enderecoIp = Context.GetHttpContext()?.Connection.RemoteIpAddress?.ToString();

        await Groups.AddToGroupAsync(Context.ConnectionId, GrupoSessao(token));
        var viewer = await _sessionService.AdicionarEspectadorAsync(token, Context.ConnectionId, enderecoIp);

        _logger.LogInformation("Espectador conectado. Token={Token} ConnectionId={ConnectionId}", token, Context.ConnectionId);

        var quantidade = await _sessionService.ContarEspectadoresAsync(token);

        // Avisa o transmissor que existe um novo espectador aguardando o Offer
        if (!string.IsNullOrEmpty(session.BroadcasterConnectionId))
        {
            await Clients.Client(session.BroadcasterConnectionId).SendAsync("NovoEspectador", Context.ConnectionId);
            await Clients.Caller.SendAsync("EspectadorConfirmado", token);
        }
        else
        {
            await Clients.Caller.SendAsync("BroadcasterOffline");
        }

        await Clients.Group(GrupoSessao(token)).SendAsync("AtualizarContagemEspectadores", quantidade);
    }

    /// <summary>
    /// Transmissor envia o SDP Offer diretamente para um espectador específico.
    /// </summary>
    public async Task EnviarOffer(string targetConnectionId, string sdpOffer)
    {
        await Clients.Client(targetConnectionId).SendAsync("ReceberOffer", Context.ConnectionId, sdpOffer);
    }

    /// <summary>
    /// Espectador envia o SDP Answer de volta para o transmissor que originou o Offer.
    /// </summary>
    public async Task EnviarAnswer(string targetConnectionId, string sdpAnswer)
    {
        await Clients.Client(targetConnectionId).SendAsync("ReceberAnswer", Context.ConnectionId, sdpAnswer);
    }

    /// <summary>
    /// Troca de ICE Candidates entre transmissor e espectador (em ambas as direções).
    /// </summary>
    public async Task EnviarIceCandidate(string targetConnectionId, string candidate)
    {
        await Clients.Client(targetConnectionId).SendAsync("ReceberIceCandidate", Context.ConnectionId, candidate);
    }

    /// <summary>
    /// Heartbeat enviado periodicamente pelo transmissor para manter a sessão marcada como ativa.
    /// </summary>
    public async Task Heartbeat(string token)
    {
        await _sessionService.AtualizarAtividadeAsync(token);
    }

    /// <summary>
    /// Chamado explicitamente pelo transmissor ao clicar em "Parar Transmissão".
    /// </summary>
    public async Task PararTransmissao(string token)
    {
        await _sessionService.EncerrarSessaoAsync(token);
        await Clients.Group(GrupoSessao(token)).SendAsync("TransmissaoEncerrada");
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, GrupoSessao(token));
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var sessionComoBroadcaster = await _sessionService.ObterPorBroadcasterConnectionIdAsync(Context.ConnectionId);

        if (sessionComoBroadcaster is not null)
        {
            await _sessionService.RemoverBroadcasterAsync(Context.ConnectionId);
            await Clients.Group(GrupoSessao(sessionComoBroadcaster.Token)).SendAsync("BroadcasterOffline");
            _logger.LogInformation("Broadcaster desconectado. Token={Token}", sessionComoBroadcaster.Token);
        }
        else
        {
            await _sessionService.RemoverEspectadorAsync(Context.ConnectionId);
        }

        await base.OnDisconnectedAsync(exception);
    }

    private static string GrupoSessao(string token) => $"session-{token}";
}
