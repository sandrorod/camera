using SecurityCam.ViewModels;

namespace SecurityCam.Services;

/// <summary>
/// Fornece a configuração de servidores ICE (STUN/TURN) usada pelo cliente WebRTC,
/// lida a partir de appsettings.json (seção "WebRtc").
/// </summary>
public interface IWebRtcConfigService
{
    List<string> ObterStunServers();

    List<TurnServerViewModel> ObterTurnServers();
}
