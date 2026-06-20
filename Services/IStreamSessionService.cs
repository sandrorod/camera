using SecurityCam.Models;

namespace SecurityCam.Services;

/// <summary>
/// Contrato para gerenciamento do ciclo de vida das sessões de transmissão:
/// criação, validação, controle de espectadores e encerramento.
/// </summary>
public interface IStreamSessionService
{
    Task<SessionModel> CriarSessaoAsync(string? senha, int? expiracaoMinutos);

    Task<SessionModel?> ObterPorTokenAsync(string token);

    Task<bool> ValidarSenhaAsync(string token, string senhaInformada);

    Task DefinirBroadcasterAsync(string token, string connectionId);

    Task<SessionModel?> ObterPorBroadcasterConnectionIdAsync(string connectionId);

    Task RemoverBroadcasterAsync(string connectionId);

    Task<ViewerModel> AdicionarEspectadorAsync(string token, string connectionId, string? enderecoIp);

    Task RemoverEspectadorAsync(string connectionId);

    Task<int> ContarEspectadoresAsync(string token);

    Task AtualizarAtividadeAsync(string token);

    Task EncerrarSessaoAsync(string token);

    Task RegistrarLogAsync(string token, TipoEventoConexao tipoEvento, string? connectionId = null, string? enderecoIp = null, string? detalhes = null);

    /// <summary>
    /// Encerra sessões sem atividade além do limite de inatividade configurado.
    /// Chamado periodicamente pelo serviço de limpeza em background.
    /// </summary>
    Task<int> EncerrarSessoesInativasAsync(TimeSpan limiteInatividade);
}
