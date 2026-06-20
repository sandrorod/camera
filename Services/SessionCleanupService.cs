using Microsoft.Extensions.Hosting;

namespace SecurityCam.Services;

/// <summary>
/// Serviço em background que periodicamente encerra sessões de transmissão
/// inativas (sem heartbeat) ou expiradas (passou da DataExpiracao configurada).
/// </summary>
public class SessionCleanupService : BackgroundService
{
    private static readonly TimeSpan IntervaloVerificacao = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan LimiteInatividade = TimeSpan.FromMinutes(5);

    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<SessionCleanupService> _logger;

    public SessionCleanupService(IServiceScopeFactory scopeFactory, ILogger<SessionCleanupService> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("SessionCleanupService iniciado. Intervalo={Intervalo} LimiteInatividade={Limite}",
            IntervaloVerificacao, LimiteInatividade);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = _scopeFactory.CreateScope();
                var sessionService = scope.ServiceProvider.GetRequiredService<IStreamSessionService>();

                var encerradas = await sessionService.EncerrarSessoesInativasAsync(LimiteInatividade);

                if (encerradas > 0)
                {
                    _logger.LogInformation("Limpeza automática encerrou {Quantidade} sessões.", encerradas);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Erro ao executar limpeza de sessões inativas.");
            }

            await Task.Delay(IntervaloVerificacao, stoppingToken).ContinueWith(_ => { });
        }
    }
}
