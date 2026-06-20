using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using SecurityCam.Data;
using SecurityCam.Models;

namespace SecurityCam.Services;

/// <summary>
/// Implementação do gerenciamento de sessões de transmissão usando EF Core + SQLite.
/// Tokens são gerados com RNGCryptoServiceProvider (criptograficamente seguros) para
/// que as URLs de compartilhamento sejam praticamente impossíveis de adivinhar.
/// </summary>
public class StreamSessionService : IStreamSessionService
{
    private const int TokenByteLength = 24; // ~32 caracteres base64url

    private readonly SecurityCamDbContext _db;
    private readonly ILogger<StreamSessionService> _logger;

    public StreamSessionService(SecurityCamDbContext db, ILogger<StreamSessionService> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task<SessionModel> CriarSessaoAsync(int? expiracaoMinutos)
    {
        var token = GerarTokenSeguro();

        var session = new SessionModel
        {
            Token = token,
            DataCriacao = DateTime.UtcNow,
            DataUltimaAtividade = DateTime.UtcNow,
            Ativa = true,
            DataExpiracao = expiracaoMinutos.HasValue ? DateTime.UtcNow.AddMinutes(expiracaoMinutos.Value) : null
        };

        _db.Sessions.Add(session);
        await _db.SaveChangesAsync();

        _logger.LogInformation("Sessão criada. Token={Token} ExpiraEm={Expiracao}", token, session.DataExpiracao);

        await RegistrarLogAsync(token, TipoEventoConexao.SessaoCriada, detalhes: "Sessão de transmissão criada");

        return session;
    }

    public async Task<SessionModel?> ObterPorTokenAsync(string token)
    {
        return await _db.Sessions
            .FirstOrDefaultAsync(s => s.Token == token);
    }

    public async Task DefinirBroadcasterAsync(string token, string connectionId)
    {
        var session = await ObterPorTokenAsync(token);
        if (session is null) return;

        session.BroadcasterConnectionId = connectionId;
        session.DataUltimaAtividade = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        await RegistrarLogAsync(token, TipoEventoConexao.BroadcasterConectado, connectionId);
    }

    public async Task<SessionModel?> ObterPorBroadcasterConnectionIdAsync(string connectionId)
    {
        return await _db.Sessions.FirstOrDefaultAsync(s => s.BroadcasterConnectionId == connectionId);
    }

    public async Task RemoverBroadcasterAsync(string connectionId)
    {
        var session = await ObterPorBroadcasterConnectionIdAsync(connectionId);
        if (session is null) return;

        session.BroadcasterConnectionId = null;
        await _db.SaveChangesAsync();

        await RegistrarLogAsync(session.Token, TipoEventoConexao.BroadcasterDesconectado, connectionId);
    }

    public async Task<ViewerModel> AdicionarEspectadorAsync(string token, string connectionId, string? enderecoIp)
    {
        var session = await ObterPorTokenAsync(token)
            ?? throw new InvalidOperationException($"Sessão com token '{token}' não encontrada.");

        var viewer = new ViewerModel
        {
            SessionId = session.Id,
            ConnectionId = connectionId,
            EnderecoIp = enderecoIp,
            DataConexao = DateTime.UtcNow,
            Conectado = true
        };

        _db.Viewers.Add(viewer);

        session.QuantidadeEspectadores = await _db.Viewers.CountAsync(v => v.SessionId == session.Id && v.Conectado) + 1;
        session.DataUltimaAtividade = DateTime.UtcNow;

        await _db.SaveChangesAsync();

        await RegistrarLogAsync(token, TipoEventoConexao.EspectadorConectado, connectionId, enderecoIp);

        return viewer;
    }

    public async Task RemoverEspectadorAsync(string connectionId)
    {
        var viewer = await _db.Viewers
            .Include(v => v.Session)
            .FirstOrDefaultAsync(v => v.ConnectionId == connectionId && v.Conectado);

        if (viewer is null) return;

        viewer.Conectado = false;
        viewer.DataDesconexao = DateTime.UtcNow;

        if (viewer.Session is not null)
        {
            viewer.Session.QuantidadeEspectadores = await _db.Viewers
                .CountAsync(v => v.SessionId == viewer.SessionId && v.Conectado && v.ConnectionId != connectionId);

            await RegistrarLogAsync(viewer.Session.Token, TipoEventoConexao.EspectadorDesconectado, connectionId, viewer.EnderecoIp);
        }

        await _db.SaveChangesAsync();
    }

    public async Task<int> ContarEspectadoresAsync(string token)
    {
        var session = await ObterPorTokenAsync(token);
        return session?.QuantidadeEspectadores ?? 0;
    }

    public async Task AtualizarAtividadeAsync(string token)
    {
        var session = await ObterPorTokenAsync(token);
        if (session is null) return;

        session.DataUltimaAtividade = DateTime.UtcNow;
        await _db.SaveChangesAsync();
    }

    public async Task EncerrarSessaoAsync(string token)
    {
        var session = await ObterPorTokenAsync(token);
        if (session is null) return;

        session.Ativa = false;
        session.BroadcasterConnectionId = null;
        await _db.SaveChangesAsync();

        await RegistrarLogAsync(token, TipoEventoConexao.SessaoEncerrada, detalhes: "Sessão encerrada");

        _logger.LogInformation("Sessão encerrada. Token={Token}", token);
    }

    public async Task RegistrarLogAsync(string token, TipoEventoConexao tipoEvento, string? connectionId = null, string? enderecoIp = null, string? detalhes = null)
    {
        var session = await ObterPorTokenAsync(token);
        if (session is null) return;

        _db.ConnectionLogs.Add(new ConnectionLogModel
        {
            SessionId = session.Id,
            TipoEvento = tipoEvento,
            ConnectionId = connectionId,
            EnderecoIp = enderecoIp,
            Detalhes = detalhes,
            DataEvento = DateTime.UtcNow
        });

        await _db.SaveChangesAsync();
    }

    public async Task<int> EncerrarSessoesInativasAsync(TimeSpan limiteInatividade)
    {
        var limite = DateTime.UtcNow - limiteInatividade;

        var sessoesInativas = await _db.Sessions
            .Where(s => s.Ativa && (s.DataUltimaAtividade < limite || (s.DataExpiracao.HasValue && s.DataExpiracao.Value < DateTime.UtcNow)))
            .ToListAsync();

        foreach (var session in sessoesInativas)
        {
            session.Ativa = false;
            session.BroadcasterConnectionId = null;

            var motivo = session.DataExpiracao.HasValue && session.DataExpiracao.Value < DateTime.UtcNow
                ? TipoEventoConexao.SessaoExpirada
                : TipoEventoConexao.SessaoEncerrada;

            _db.ConnectionLogs.Add(new ConnectionLogModel
            {
                SessionId = session.Id,
                TipoEvento = motivo,
                Detalhes = "Encerrada automaticamente por inatividade ou expiração",
                DataEvento = DateTime.UtcNow
            });
        }

        if (sessoesInativas.Count > 0)
        {
            await _db.SaveChangesAsync();
            _logger.LogInformation("Encerradas {Quantidade} sessões inativas/expiradas.", sessoesInativas.Count);
        }

        return sessoesInativas.Count;
    }

    private static string GerarTokenSeguro()
    {
        var bytes = RandomNumberGenerator.GetBytes(TokenByteLength);
        return Convert.ToBase64String(bytes)
            .Replace("+", "-")
            .Replace("/", "_")
            .Replace("=", "");
    }

}
