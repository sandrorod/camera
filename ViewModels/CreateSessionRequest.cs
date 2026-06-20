namespace SecurityCam.ViewModels;

/// <summary>
/// Payload recebido pela API para criar uma nova sessão de transmissão.
/// </summary>
public class CreateSessionRequest
{
    /// <summary>
    /// Senha opcional para proteger a transmissão. Nulo/vazio = sem senha.
    /// </summary>
    public string? Senha { get; set; }

    /// <summary>
    /// Minutos até a expiração automática do link. Nulo = sem expiração.
    /// </summary>
    public int? ExpiracaoMinutos { get; set; }
}

/// <summary>
/// Resposta da API ao criar uma sessão.
/// </summary>
public class CreateSessionResponse
{
    public string Token { get; set; } = string.Empty;
    public string BroadcasterUrl { get; set; } = string.Empty;
    public string ViewerUrl { get; set; } = string.Empty;
    public DateTime? DataExpiracao { get; set; }
}

/// <summary>
/// Payload para validar a senha de uma transmissão protegida.
/// </summary>
public class ValidatePasswordRequest
{
    public string Token { get; set; } = string.Empty;
    public string Senha { get; set; } = string.Empty;
}

/// <summary>
/// Informações públicas e em tempo real sobre uma sessão (para polling/status).
/// </summary>
public class SessionStatusResponse
{
    public string Token { get; set; } = string.Empty;
    public bool Ativa { get; set; }
    public bool RequerSenha { get; set; }
    public bool Expirada { get; set; }
    public int QuantidadeEspectadores { get; set; }
    public DateTime DataUltimaAtividade { get; set; }
}
