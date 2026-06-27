// db.js
// Persistência das câmeras/sessões no Supabase. Diferente do estado em memória
// do sessionStore.js (sockets, peer connections — efêmero por natureza), esta
// tabela guarda só o registro de quais links/câmeras já foram criados, para que
// o dashboard liste todas as câmeras de qualquer dispositivo, não só de quem
// gerou o link originalmente.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

if (!supabase) {
    console.warn('[db] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não configurados — persistência de câmeras desativada.');
}

async function registrarCamera(sessionToken, cameraId, nome) {
    if (!supabase) return;
    const { error } = await supabase
        .from('cameras')
        .upsert({ session_token: sessionToken, camera_id: cameraId, nome }, { onConflict: 'session_token,camera_id' });

    if (error) console.error('[db] Erro ao registrar câmera:', error.message);
}

async function listarCamerasPorSessao(sessionToken) {
    if (!supabase) return [];
    const { data, error } = await supabase
        .from('cameras')
        .select('camera_id, nome, created_at')
        .eq('session_token', sessionToken);

    if (error) {
        console.error('[db] Erro ao listar câmeras da sessão:', error.message);
        return [];
    }
    return data;
}

async function listarTokensDeSessao() {
    if (!supabase) return [];
    const { data, error } = await supabase
        .from('cameras')
        .select('session_token')
        .order('created_at', { ascending: false });

    if (error) {
        console.error('[db] Erro ao listar tokens de sessão:', error.message);
        return [];
    }
    return [...new Set(data.map((row) => row.session_token))];
}

async function removerCamerasPorSessao(sessionToken) {
    if (!supabase) return;
    const { error } = await supabase.from('cameras').delete().eq('session_token', sessionToken);
    if (error) console.error('[db] Erro ao remover câmeras da sessão:', error.message);
}

module.exports = {
    registrarCamera,
    listarCamerasPorSessao,
    listarTokensDeSessao,
    removerCamerasPorSessao
};
