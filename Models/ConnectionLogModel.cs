using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace SecurityCam.Models;

/// <summary>
/// Tipo de evento registrado no log de conexões, usado para auditoria e diagnóstico.
/// </summary>
public enum TipoEventoConexao
{
    SessaoCriada,
    BroadcasterConectado,
    BroadcasterDesconectado,
    EspectadorConectado,
    EspectadorDesconectado,
    OfferEnviado,
    AnswerEnviado,
    IceCandidateTrocado,
    SessaoExpirada,
    SessaoEncerrada
}

/// <summary>
/// Log estruturado de eventos de conexão para auditoria de cada sessão.
/// </summary>
[Table("ConnectionLogs")]
public class ConnectionLogModel
{
    [Key]
    public int Id { get; set; }

    [Required]
    public int SessionId { get; set; }

    [ForeignKey(nameof(SessionId))]
    public SessionModel? Session { get; set; }

    [Required]
    public TipoEventoConexao TipoEvento { get; set; }

    [MaxLength(64)]
    public string? ConnectionId { get; set; }

    [MaxLength(64)]
    public string? EnderecoIp { get; set; }

    [MaxLength(512)]
    public string? Detalhes { get; set; }

    public DateTime DataEvento { get; set; } = DateTime.UtcNow;
}
