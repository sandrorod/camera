using Microsoft.Extensions.Configuration;
using SecurityCam.ViewModels;

namespace SecurityCam.Services;

public class WebRtcConfigService : IWebRtcConfigService
{
    private readonly IConfiguration _configuration;

    public WebRtcConfigService(IConfiguration configuration)
    {
        _configuration = configuration;
    }

    public List<string> ObterStunServers()
    {
        var servers = _configuration.GetSection("WebRtc:StunServers").Get<List<string>>();
        return servers is { Count: > 0 } ? servers : new List<string> { "stun:stun.l.google.com:19302" };
    }

    public List<TurnServerViewModel> ObterTurnServers()
    {
        return _configuration.GetSection("WebRtc:TurnServers").Get<List<TurnServerViewModel>>() ?? new List<TurnServerViewModel>();
    }
}
