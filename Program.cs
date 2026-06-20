using Microsoft.EntityFrameworkCore;
using SecurityCam.Data;
using SecurityCam.Hubs;
using SecurityCam.Services;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

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

// HSTS força HTTPS em produção, requisito de segurança para getUserMedia funcionar fora de localhost.
builder.Services.AddHsts(options =>
{
    options.Preload = true;
    options.IncludeSubDomains = true;
    options.MaxAge = TimeSpan.FromDays(365);
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
    app.UseHsts();
}

// HTTPS é obrigatório: getUserMedia (câmera/microfone) só funciona em contexto seguro
// (HTTPS) ou em localhost. Em produção, o redirecionamento abaixo garante isso.
app.UseHttpsRedirection();

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
