FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

COPY SecurityCam.csproj .
RUN dotnet restore SecurityCam.csproj

COPY . .
RUN dotnet publish SecurityCam.csproj -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
WORKDIR /app
COPY --from=build /app .

# Railway injeta a porta pública via variável de ambiente PORT em tempo de execução.
ENV ASPNETCORE_ENVIRONMENT=Production
EXPOSE 8080

ENTRYPOINT ["dotnet", "SecurityCam.dll"]
