using Microsoft.AspNetCore.Mvc;
using SecurityCam.Services;
using SecurityCam.ViewModels;

namespace SecurityCam.Controllers;

/// <summary>
/// Controller responsável pelas páginas (broadcaster/viewer) e pela API REST
/// de criação e consulta de sessões de transmissão.
/// </summary>
public class StreamController : Controller
{
    private readonly IStreamSessionService _sessionService;
    private readonly IWebRtcConfigService _webRtcConfigService;
    private readonly ILogger<StreamController> _logger;

    public StreamController(
        IStreamSessionService sessionService,
        IWebRtcConfigService webRtcConfigService,
        ILogger<StreamController> logger)
    {
        _sessionService = sessionService;
        _webRtcConfigService = webRtcConfigService;
        _logger = logger;
    }

    /// <summary>
    /// Página inicial: permite criar uma nova transmissão.
    /// </summary>
    [HttpGet("/")]
    public IActionResult Index()
    {
        return View();
    }

    /// <summary>
    /// Página genérica de erro, usada pelo middleware de tratamento de exceções em produção.
    /// </summary>
    [HttpGet("/stream/erro")]
    public IActionResult Erro()
    {
        return View();
    }

    /// <summary>
    /// Cria uma nova sessão e redireciona o transmissor para a página da câmera.
    /// </summary>
    [HttpPost("/stream/criar")]
    public async Task<IActionResult> Criar([FromForm] int? expiracaoMinutos)
    {
        var session = await _sessionService.CriarSessaoAsync(senha: null, expiracaoMinutos);
        return RedirectToAction(nameof(Broadcaster), new { token = session.Token });
    }

    /// <summary>
    /// Página do transmissor: ativa a câmera do celular e inicia a transmissão.
    /// </summary>
    [HttpGet("/stream/broadcaster/{token}")]
    public async Task<IActionResult> Broadcaster(string token)
    {
        var session = await _sessionService.ObterPorTokenAsync(token);
        if (session is null)
        {
            return NotFound("Sessão de transmissão não encontrada.");
        }

        var viewModel = new BroadcasterViewModel
        {
            Token = token,
            ViewerShareUrl = Url.Action(nameof(Viewer), "Stream", new { token }, Request.Scheme) ?? string.Empty,
            StunServers = _webRtcConfigService.ObterStunServers(),
            TurnServers = _webRtcConfigService.ObterTurnServers()
        };

        return View(viewModel);
    }

    /// <summary>
    /// Página do espectador: assiste à transmissão ao vivo através do link compartilhado.
    /// </summary>
    [HttpGet("/stream/viewer/{token}")]
    public async Task<IActionResult> Viewer(string token)
    {
        var session = await _sessionService.ObterPorTokenAsync(token);

        var viewModel = new ViewerPageViewModel
        {
            Token = token,
            SessaoExiste = session is not null,
            SessaoAtiva = session is { Ativa: true } && !session.Expirada,
            RequerSenha = session?.PossuiSenha ?? false,
            StunServers = _webRtcConfigService.ObterStunServers(),
            TurnServers = _webRtcConfigService.ObterTurnServers()
        };

        return View(viewModel);
    }

    /// <summary>
    /// API: cria uma sessão de transmissão (uso programático/AJAX).
    /// </summary>
    [HttpPost("/api/stream/sessions")]
    public async Task<ActionResult<CreateSessionResponse>> CriarSessaoApi([FromBody] CreateSessionRequest request)
    {
        var session = await _sessionService.CriarSessaoAsync(request.Senha, request.ExpiracaoMinutos);

        var response = new CreateSessionResponse
        {
            Token = session.Token,
            BroadcasterUrl = Url.Action(nameof(Broadcaster), "Stream", new { token = session.Token }, Request.Scheme) ?? string.Empty,
            ViewerUrl = Url.Action(nameof(Viewer), "Stream", new { token = session.Token }, Request.Scheme) ?? string.Empty,
            DataExpiracao = session.DataExpiracao
        };

        return Ok(response);
    }

    /// <summary>
    /// API: consulta o status atual de uma sessão (espectadores, atividade, etc).
    /// Usado pela página do transmissor para atualizar indicadores em tempo real.
    /// </summary>
    [HttpGet("/api/stream/sessions/{token}/status")]
    public async Task<ActionResult<SessionStatusResponse>> ObterStatus(string token)
    {
        var session = await _sessionService.ObterPorTokenAsync(token);
        if (session is null)
        {
            return NotFound();
        }

        return Ok(new SessionStatusResponse
        {
            Token = session.Token,
            Ativa = session.Ativa,
            RequerSenha = session.PossuiSenha,
            Expirada = session.Expirada,
            QuantidadeEspectadores = session.QuantidadeEspectadores,
            DataUltimaAtividade = session.DataUltimaAtividade
        });
    }

    /// <summary>
    /// API: valida a senha de uma transmissão protegida antes de conectar via SignalR.
    /// </summary>
    [HttpPost("/api/stream/sessions/validar-senha")]
    public async Task<IActionResult> ValidarSenha([FromBody] ValidatePasswordRequest request)
    {
        var valido = await _sessionService.ValidarSenhaAsync(request.Token, request.Senha);
        return Ok(new { valido });
    }

    /// <summary>
    /// API: encerra manualmente uma sessão de transmissão.
    /// </summary>
    [HttpPost("/api/stream/sessions/{token}/encerrar")]
    public async Task<IActionResult> Encerrar(string token)
    {
        await _sessionService.EncerrarSessaoAsync(token);
        return Ok();
    }
}
