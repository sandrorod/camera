using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace SecurityCam.Models;

/// <summary>
/// Representa uma sessão de transmissão (broadcast) de câmera.
/// Cada sessão tem um token único usado na URL pública compartilhável.
/// </summary>
[Table("Sessions")]
public class SessionModel
{
    [Key]
    public int Id { get; set; }

    /// <summary>
    /// Token único e aleatório usado na URL de transmissão/visualização.
    /// Gerado com RNGCryptoServiceProvider para evitar URLs adivinháveis.
    /// </summary>
    [Required]
    [MaxLength(64)]
    public string Token { get; set; } = string.Empty;

    /// <summary>
    /// Identificador de conexão SignalR do transmissor atual (não persistido entre restarts).
    /// </summary>
    [MaxLength(64)]
    public string? BroadcasterConnectionId { get; set; }

    public DateTime DataCriacao { get; set; } = DateTime.UtcNow;

    public DateTime DataUltimaAtividade { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// Hash da senha de proteção da transmissão (PBKDF2). Nulo se não houver senha.
    /// </summary>
    [MaxLength(256)]
    public string? SenhaHash { get; set; }

    public bool PossuiSenha => !string.IsNullOrEmpty(SenhaHash);

    public bool Ativa { get; set; } = true;

    public int QuantidadeEspectadores { get; set; } = 0;

    /// <summary>
    /// Data/hora de expiração opcional do link. Nulo significa sem expiração.
    /// </summary>
    public DateTime? DataExpiracao { get; set; }

    public bool Expirada => DataExpiracao.HasValue && DateTime.UtcNow > DataExpiracao.Value;

    public ICollection<ViewerModel> Viewers { get; set; } = new List<ViewerModel>();

    public ICollection<ConnectionLogModel> ConnectionLogs { get; set; } = new List<ConnectionLogModel>();
}
