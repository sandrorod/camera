using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.EntityFrameworkCore;
using SecurityCam.Data;
using SecurityCam.Hubs;
using SecurityCam.Services;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

// Railway (e plataformas similares) injetam a porta via variável de ambiente PORT
// e fazem terminação TLS no proxy reverso deles, então a app escuta HTTP internamente.
var porta = Environment.GetEnvironmentVariable("PORT");
if (!string.IsNullOrEmpty(porta))
{
    builder.WebHost.UseUrls($"http://0.0.0.0:{porta}");
}

// ----- Logs estruturados (Serilog) -----
// Console + arquivo rolante diário, com enriquecimento de contexto (machine name, thread id).
Log.Logger = new LoggerConfiguration()
    .ReadFrom.Configuration(builder.Configuration)
    .Enrich.FromLogContext()
    .Enrich.WithMachineName()
    .Enrich.WithThreadId()
    .WriteTo.Console()
    .WriteTo.File("logs/securitycam-.log", rollingInterval: RollingInterval.Day, retainedFileCountLimit: 14)
    .CreateLogger();

builder.Host.UseSerilog();

// ----- MVC + SignalR -----
builder.Services.AddControllersWithViews();
builder.Services.AddSignalR(options =>
{
    options.EnableDetailedErrors = builder.Environment.IsDevelopment();
    options.MaximumReceiveMessageSize = 64 * 1024; // mensagens de signaling são pequenas (SDP/ICE)
    options.ClientTimeoutInterval = TimeSpan.FromSeconds(30);
    options.KeepAliveInterval = TimeSpan.FromSeconds(15);
});

// ----- Banco de dados (SQLite via EF Core) -----
builder.Services.AddDbContext<SecurityCamDbContext>(options =>
    options.UseSqlite(builder.Configuration.GetConnectionString("DefaultConnection")
        ?? "Data Source=securitycam.db"));

// ----- Injeção de dependência dos serviços de domínio -----
builder.Services.AddScoped<IStreamSessionService, StreamSessionService>();
builder.Services.AddSingleton<IWebRtcConfigService, WebRtcConfigService>();
builder.Services.AddHostedService<SessionCleanupService>();

// ----- CORS: necessário pois o espectador e o transmissor podem estar em origens diferentes
// (ex: app mobile embarcado, ou domínio customizado por trás de proxy reverso).
builder.Services.AddCors(options =>
{
    options.AddPolicy("SecurityCamPolicy", policy =>
    {
        var origensPermitidas = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>();

        if (origensPermitidas is { Length: > 0 })
        {
            policy.WithOrigins(origensPermitidas)
                  .AllowAnyHeader()
                  .AllowAnyMethod()
                  .AllowCredentials();
        }
        else
        {
            // Em desenvolvimento, sem origens configuradas: permite qualquer origem (sem credentials).
            policy.AllowAnyHeader().AllowAnyMethod().SetIsOriginAllowed(_ => true);
        }
    });
});

var app = builder.Build();

// ----- Criação/migração automática do banco de dados no startup -----
// Se existirem migrations geradas (dotnet ef migrations add), elas são aplicadas.
// Caso contrário (primeira execução sem migrations), o schema é criado diretamente a partir dos modelos.
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<SecurityCamDbContext>();
    if (db.Database.GetPendingMigrations().Any() || db.Database.GetAppliedMigrations().Any())
    {
        db.Database.Migrate();
    }
    else
    {
        db.Database.EnsureCreated();
    }
}

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Stream/Erro");
}

// Em plataformas como Railway, o proxy reverso já termina HTTPS e encaminha a
// requisição internamente como HTTP — confiamos nos cabeçalhos X-Forwarded-* para
// que Request.Scheme/IsHttps reflitam corretamente o protocolo público.
app.UseForwardedHeaders(new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto
});

app.UseStaticFiles();

app.UseRouting();

app.UseCors("SecurityCamPolicy");

app.UseAuthorization();

app.MapControllerRoute(
    name: "default",
    pattern: "{controller=Stream}/{action=Index}/{id?}");

app.MapHub<CameraHub>("/hubs/camera");

try
{
    Log.Information("SecurityCam iniciando...");
    app.Run();
}
finally
{
    Log.CloseAndFlush();
}
