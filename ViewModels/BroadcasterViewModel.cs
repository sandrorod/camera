namespace SecurityCam.ViewModels;

/// <summary>
/// Dados enviados para a view do transmissor (página que ativa a câmera do celular).
/// </summary>
public class BroadcasterViewModel
{
    public string Token { get; set; } = string.Empty;

    public string ViewerShareUrl { get; set; } = string.Empty;

    public List<string> StunServers { get; set; } = new();

    public List<TurnServerViewModel> TurnServers { get; set; } = new();
}

public class TurnServerViewModel
{
    public string Urls { get; set; } = string.Empty;
    public string? Username { get; set; }
    public string? Credential { get; set; }
}
