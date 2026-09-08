-- Tabela chave-valor simples para configurações globais persistentes da
-- aplicação. Usada primeiro para guardar o token do link único fixo do
-- dashboard (chave 'link_unico_token'), gerado uma única vez e reutilizado
-- para sempre — sem isso, o token vivia só em memória (sessionStore) e no
-- localStorage de quem gerou o link, e sumia a cada restart do servidor ou
-- ao abrir o dashboard em outro navegador/dispositivo sem esse localStorage.
--
-- Rode este script uma vez no SQL Editor do Supabase.

create table if not exists app_settings (
    key text primary key,
    value text not null,
    updated_at timestamptz not null default now()
);
