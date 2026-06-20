using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace SecurityCam.Models;

/// <summary>
/// Representa um espectador conectado a uma sessão de transmissão.
/// </summary>
[Table("Viewers")]
public class ViewerModel
{
    [Key]
    public int Id { get; set; }

    [Required]
    public int SessionId { get; set; }

    [ForeignKey(nameof(SessionId))]
    public SessionModel? Session { get; set; }

    /// <summary>
    /// Identificador de conexão SignalR do espectador.
    /// </summary>
    [Required]
    [MaxLength(64)]
    public string ConnectionId { get; set; } = string.Empty;

    [MaxLength(64)]
    public string? EnderecoIp { get; set; }

    public DateTime DataConexao { get; set; } = DateTime.UtcNow;

    public DateTime? DataDesconexao { get; set; }

    public bool Conectado { get; set; } = true;
}
