using Microsoft.EntityFrameworkCore;
using SecurityCam.Models;

namespace SecurityCam.Data;

public class SecurityCamDbContext : DbContext
{
    public SecurityCamDbContext(DbContextOptions<SecurityCamDbContext> options) : base(options)
    {
    }

    public DbSet<SessionModel> Sessions => Set<SessionModel>();

    public DbSet<ViewerModel> Viewers => Set<ViewerModel>();

    public DbSet<ConnectionLogModel> ConnectionLogs => Set<ConnectionLogModel>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<SessionModel>(entity =>
        {
            entity.HasIndex(s => s.Token).IsUnique();
            entity.HasIndex(s => s.Ativa);
        });

        modelBuilder.Entity<ViewerModel>(entity =>
        {
            entity.HasOne(v => v.Session)
                  .WithMany(s => s.Viewers)
                  .HasForeignKey(v => v.SessionId)
                  .OnDelete(DeleteBehavior.Cascade);

            entity.HasIndex(v => v.ConnectionId);
        });

        modelBuilder.Entity<ConnectionLogModel>(entity =>
        {
            entity.HasOne(c => c.Session)
                  .WithMany(s => s.ConnectionLogs)
                  .HasForeignKey(c => c.SessionId)
                  .OnDelete(DeleteBehavior.Cascade);

            entity.HasIndex(c => c.DataEvento);
        });

        base.OnModelCreating(modelBuilder);
    }
}
