namespace SecurityCam.ViewModels;

/// <summary>
/// Dados enviados para a view do espectador (página que assiste à transmissão).
/// </summary>
public class ViewerPageViewModel
{
    public string Token { get; set; } = string.Empty;

    public bool SessaoExiste { get; set; }

    public bool SessaoAtiva { get; set; }

    public List<string> StunServers { get; set; } = new();

    public List<TurnServerViewModel> TurnServers { get; set; } = new();
}
