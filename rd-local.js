/* rd-local.js: o "servidor" que roda DENTRO do iPhone (ou de qualquer navegador).
 * Mesmas regras do server.py, mas os dados ficam no IndexedDB do próprio aparelho:
 * sem Mac, sem Wi-Fi de casa, sem Claude Code. Nada é enviado a ninguém.
 * Única consulta externa: busca pública do sq ft (Censo dos EUA + MassGIS), só com o endereço.
 */
(function () {
"use strict";

// ------------------------------------------------------------------ utilidades
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const unhex = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
const agoraISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19);
const hojeISO = () => agoraISO().slice(0, 10);
const r2 = (x, n = 2) => Number(Number(x).toFixed(n));
const RE_ID = /^[A-Za-z0-9-]{8,64}$/;
const RE_EMAIL = /^[^@\s]{1,64}@[^@\s]{1,200}\.[^@\s]{2,}$/;
const RE_DINHEIRO = /\$?\s?(\d{1,3}(?:,\d{3})+|\d+)[.,](\d{2})(?!\d)/g;
const ITEM_TRUCK = "Truck (estimativa)", ITEM_SUB = "Sub-contrato";
const ITER = 600000;
const ERRO = (msg, http = 400) => Object.assign(new Error(msg), {http});

function numero(v) {   // igual ao server.py: tira vírgula e $, devolve null se não for número
  const s = String(v ?? "").replace(/,/g, "").replace(/\$/g, "").trim();
  if (s === "" || !isFinite(Number(s))) return null;
  return r2(Number(s));
}
const sq = s => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// ------------------------------------------------------------------ banco de dados no aparelho (IndexedDB)
let _db = null;
function abrirDB() {
  return new Promise((ok, er) => {
    const r = indexedDB.open("receitas-despesas", 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("kv"); r.result.createObjectStore("fotos"); };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => er(r.error);
  });
}
async function db() { return _db || (_db = await abrirDB()); }
async function tx(loja, modo, fn) {
  const d = await db();
  return new Promise((ok, er) => {
    const t = d.transaction(loja, modo); const s = t.objectStore(loja); let res;
    Promise.resolve(fn(s)).then(r => { res = r; }).catch(er);
    t.oncomplete = () => ok(res); t.onerror = () => er(t.error); t.onabort = () => er(t.error);
  });
}
const pedido = r => new Promise((ok, er) => { r.onsuccess = () => ok(r.result); r.onerror = () => er(r.error); });
// No programa de Mac/Windows o armazenamento é um arquivo SQLite (window.RD_STORE); no navegador/iPhone é o IndexedDB.
const STORE = window.RD_STORE || null;
const bin = async b => ({tipo: b.type, buf: await b.arrayBuffer()});
const desbin = o => new Blob([o.buf], {type: o.tipo});
const kvGet = k => STORE ? STORE.kvGet(k) : tx("kv", "readonly", s => pedido(s.get(k)));
const kvSet = (k, v) => STORE ? STORE.kvSet(k, v) : tx("kv", "readwrite", s => pedido(s.put(v, k)));
const kvDel = k => STORE ? STORE.kvDel(k) : tx("kv", "readwrite", s => pedido(s.delete(k)));
const fotoGet = async id => { if (!STORE) return tx("fotos", "readonly", s => pedido(s.get(id))); const f = await STORE.fotoGet(id); return f ? {full: desbin(f.full), mini: desbin(f.mini)} : undefined; };
const fotoSet = async (id, v) => STORE ? STORE.fotoSet(id, {full: await bin(v.full), mini: await bin(v.mini)}) : tx("fotos", "readwrite", s => pedido(s.put(v, id)));
const fotoDel = id => STORE ? STORE.fotoDel(id) : tx("fotos", "readwrite", s => pedido(s.delete(id)));
const fotoChaves = () => STORE ? STORE.fotoChaves() : tx("fotos", "readonly", s => pedido(s.getAllKeys()));

// uma operação por vez (leitura + gravação não se misturam)
let _fila = Promise.resolve();
const comTrava = fn => { const p = _fila.then(fn, fn); _fila = p.catch(() => {}); return p; };

// ------------------------------------------------------------------ dados e configuração
const BASE_PADRAO = "";   // cada empresa coloca a sua base em Setup > Base e trucks
function configCompleta(c) {
  c = {...(c || {})};
  if (c.base == null) c.base = BASE_PADRAO;
  if (c.gasolina == null) c.gasolina = 0;
  if (c.gasolina_data == null) c.gasolina_data = "";
  c.empresa = {nome: "", logo_v: 0, ...(c.empresa || {})};
  c.exportacao = {ativa: false, pasta: "", ...(c.exportacao || {})};
  const v = {...(c.veiculos || {})};
  for (const k of ["dono", "work"]) v[k] = {modelo: "", mpg: 0, outros: 0, fonte_mpg: "", gasolina: 0, gasolina_data: "", ...(v[k] || {})};
  c.veiculos = v;
  return c;
}
async function lerTudo() {
  const d = (await kvGet("dados")) || {jobs: [], lancamentos: [], config: null, atualizado: null};
  d.jobs = d.jobs || []; d.lancamentos = d.lancamentos || [];
  d.config = configCompleta(d.config);
  return d;
}
async function gravarTudo(d) { d.atualizado = agoraISO(); await kvSet("dados", d); }

const precoGasolina = (cfg, k) => cfg.veiculos[k].gasolina || cfg.gasolina;
const custoMilha = (cfg, k) => { const v = cfg.veiculos[k]; return (v.mpg ? precoGasolina(cfg, k) / v.mpg : 0) + v.outros; };
function truckDoJob(job, cfg) {
  const milhas = job.milhas || 0, miD = (job.idas_dono || 0) * 2 * milhas, miW = (job.dias_work || 0) * 2 * milhas;
  const dono = miD * custoMilha(cfg, "dono"), work = miW * custoMilha(cfg, "work");
  return {mi_dono: miD, mi_work: miW, dono: r2(dono), work: r2(work), total: r2(dono + work)};
}

// ------------------------------------------------------------------ segurança: instalação, senha, sessão
async function pbkdf2(senha, sal, it = ITER) {
  const k = await crypto.subtle.importKey("raw", enc.encode(String(senha)), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: it}, k, 256));
}
function checarSenhaNova(s1, s2) {
  s1 = String(s1 ?? ""); s2 = String(s2 ?? "");
  if (s1 !== s2) throw ERRO("As senhas não são iguais");
  if (s1.length < 8) throw ERRO("A senha precisa de pelo menos 8 caracteres");
  if (s1.length > 200) throw ERRO("A senha é longa demais");
  return s1;
}
async function senhaConfere(senha) {
  const a = await kvGet("auth"); if (!a) return false;
  return (await pbkdf2(senha, unhex(a.sal), a.iter || ITER)) === a.hash;
}
async function conferirComLimite(senha) {
  const f = (await kvGet("falhas")) || {n: 0, ate: 0}, agora = Date.now() / 1000;
  if (agora < f.ate) throw ERRO(`Muitas tentativas. Espere ${Math.floor(f.ate - agora) + 1} segundos`, 429);
  if (await senhaConfere(senha)) { await kvSet("falhas", {n: 0, ate: 0}); return true; }
  f.n += 1; if (f.n >= 5) { f.ate = agora + 60; f.n = 0; }
  await kvSet("falhas", f);
  throw ERRO("Senha incorreta", 401);
}
const sha256hex = async s => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function novaSessao() {
  const tok = hex(crypto.getRandomValues(new Uint8Array(32)));
  const s = (await kvGet("sessoes")) || {}, agora = Date.now() / 1000;
  for (const k of Object.keys(s)) if (s[k] < agora) delete s[k];
  s[await sha256hex(tok)] = agora + 30 * 86400;
  await kvSet("sessoes", s);
  localStorage.setItem("rd-sess", tok);
}
async function sessaoOk() {
  const tok = localStorage.getItem("rd-sess"); if (!tok || !(await kvGet("auth"))) return false;
  const s = (await kvGet("sessoes")) || {};
  return (s[await sha256hex(tok)] || 0) > Date.now() / 1000;
}
async function encerrarSessao() {
  const tok = localStorage.getItem("rd-sess");
  if (tok) { const s = (await kvGet("sessoes")) || {}; delete s[await sha256hex(tok)]; await kvSet("sessoes", s); }
  localStorage.removeItem("rd-sess");
}

// ------------------------------------------------------------------ logo e fotos (guardadas no aparelho)
let _logoUrl = "";
async function atualizarLogoUrl() {
  if (_logoUrl) URL.revokeObjectURL(_logoUrl);
  const l = await fotoGet("__logo"); _logoUrl = l ? URL.createObjectURL(l.full) : "";
  api.logoUrl = _logoUrl;
}
const MINI = {};     // nome da foto -> endereço da miniatura (para a lista)
async function dataUrlParaBlob(du) { return (await fetch(du)).blob(); }
function redimensionar(blob, max, qualidade) {
  return new Promise((ok, er) => {
    const url = URL.createObjectURL(blob), img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      c.toBlob(b => b ? ok(b) : er(new Error("imagem inválida")), "image/jpeg", qualidade);
    };
    img.onerror = () => { URL.revokeObjectURL(url); er(new Error("imagem inválida")); };
    img.src = url;
  });
}
async function guardarFoto(id, blobCompleto) {
  const mini = await redimensionar(blobCompleto, 240, 0.7);
  await fotoSet(id + ".jpg", {full: blobCompleto, mini});
}
async function precarregarMinis(lancs) {
  for (const l of lancs) {
    if (!l.foto || MINI[l.foto]) continue;
    const f = await fotoGet(l.foto);
    if (f) MINI[l.foto] = URL.createObjectURL(f.mini);
  }
}
const _full = {};
async function fotoCompleta(nome) {
  if (_full[nome]) return _full[nome];
  const f = await fotoGet(nome); if (!f) return null;
  return (_full[nome] = URL.createObjectURL(f.full));
}

// ------------------------------------------------------------------ jobs, despesas, config
async function salvarConfig(corpo) {
  return comTrava(async () => {
    const n = v => { const x = numero(v == null || v === "" ? 0 : v); if (x == null || x < 0) throw ERRO("número inválido na configuração"); return x; };
    const dados = await lerTudo(), c = dados.config;
    c.base = String(corpo.base || "").trim().slice(0, 120);
    const hoje = hojeISO();
    const preco = v => {
      const x = Number(String(v == null || v === "" ? 0 : v).replace(",", ".").replace("$", "").trim());
      if (!isFinite(x) || x < 0) throw ERRO("preço da gasolina inválido");
      if (x > 20) throw ERRO("preço da gasolina parece errado (use ponto: 4.298)");
      return r2(x, 3);
    };
    const novo = preco(corpo.gasolina);
    if (novo !== c.gasolina) c.gasolina_data = hoje;
    c.gasolina = novo;
    for (const k of ["dono", "work"]) {
      const v = (corpo.veiculos || {})[k] || {}, atual = c.veiculos[k], proprio = preco(v.gasolina);
      if (proprio !== (atual.gasolina || 0)) atual.gasolina_data = proprio ? hoje : "";
      Object.assign(atual, {modelo: String(v.modelo || "").trim().slice(0, 80), mpg: n(v.mpg), outros: n(v.outros), fonte_mpg: String(v.fonte_mpg || "").trim().slice(0, 200), gasolina: proprio});
    }
    await gravarTudo(dados);
    return c;
  });
}
async function salvarJob(corpo) {
  return comTrava(async () => {
    const ident = corpo.id || crypto.randomUUID();
    if (!RE_ID.test(ident)) throw ERRO("id inválido");
    const nome = String(corpo.nome || "").trim().slice(0, 80);
    if (!nome) throw ERRO("falta o nome do job");
    const receita = numero(corpo.receita || 0);
    if (receita == null || receita < 0) throw ERRO("cheque total inválido");
    const inteiro = (chave, padrao) => {
      const bruto = corpo[chave] === undefined || corpo[chave] === "" ? padrao : corpo[chave];
      const v = numero(bruto); if (v == null || v < 0) throw ERRO(`valor inválido em ${chave}`); return v;
    };
    const campos = {nome, receita, cidade: String(corpo.cidade || "").trim().slice(0, 40), status: corpo.status === "fechado" ? "fechado" : "aberto",
      sqft: inteiro("sqft", 0), endereco: String(corpo.endereco || "").trim().slice(0, 160), milhas: inteiro("milhas", 0),
      idas_dono: Math.trunc(inteiro("idas_dono", 4)), dias_work: Math.trunc(inteiro("dias_work", 0)),
      dias_trabalhados: Math.trunc(inteiro("dias_trabalhados", 0)), pessoas: Math.trunc(inteiro("pessoas", 0))};
    const horasDia = inteiro("horas_dia", 8);
    if (horasDia > 24) throw ERRO("horas por dia inválidas");
    campos.horas_dia = horasDia;
    for (const ch of ["data_inicio", "data_fim"]) {
      const v = String(corpo[ch] || "").trim().slice(0, 10);
      if (v && !(/^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(v + "T00:00:00Z")))) throw ERRO("data inválida");
      campos[ch] = v;
    }
    if (campos.data_inicio && campos.data_fim && campos.data_fim < campos.data_inicio) throw ERRO("data final antes da inicial");
    const dados = await lerTudo();
    let job = dados.jobs.find(j => j.id === ident);
    if (job) Object.assign(job, campos); else { job = {id: ident, criado: agoraISO(), ...campos}; dados.jobs.push(job); }
    if ("subcontrato" in corpo) {   // sub-contrato = 1ª despesa do job (valor total combinado)
      const sub = numero(corpo.subcontrato || 0);
      if (sub == null || sub < 0) throw ERRO("valor do sub-contrato inválido");
      const lid = "sub-" + ident, ex = dados.lancamentos.find(l => l.id === lid), agora = agoraISO();
      if (sub > 0) {
        if (ex) { Object.assign(ex, {valor: sub, editado: agora}); delete ex.excluido; }
        else dados.lancamentos.push({id: lid, criado: agora, job_id: ident, valor: sub, item: ITEM_SUB, descricao: "", loja: "", data: hojeISO(), origem: "sub-contrato"});
      } else if (ex && !ex.excluido) ex.excluido = agora;
    }
    await gravarTudo(dados);
    return job;
  });
}
async function salvarLancamento(corpo) {
  return comTrava(async () => {
    const ident = corpo.id || crypto.randomUUID();
    if (!RE_ID.test(ident)) throw ERRO("id inválido");
    const valor = numero(corpo.valor ?? "");
    if (valor == null || valor <= 0) throw ERRO("valor inválido");
    const jobId = String(corpo.job_id || "");
    const campos = {job_id: jobId, valor, item: String(corpo.item || "Outros").trim().slice(0, 60), descricao: String(corpo.descricao || "").trim().slice(0, 300),
      loja: String(corpo.loja || "").trim().slice(0, 80), data: String(corpo.data || hojeISO()).slice(0, 10)};
    const dados = await lerTudo();
    if (!dados.jobs.some(j => j.id === jobId)) throw ERRO("job não encontrado");
    const ex = dados.lancamentos.find(l => l.id === ident);
    if (corpo.foto) { await guardarFoto(ident, await dataUrlParaBlob(corpo.foto)); campos.foto = ident + ".jpg"; delete MINI[campos.foto]; delete _full[campos.foto]; }
    let l;
    if (ex) { Object.assign(ex, campos); ex.editado = agoraISO(); l = ex; } else { l = {id: ident, criado: agoraISO(), ...campos}; dados.lancamentos.push(l); }
    await gravarTudo(dados);
    return l;
  });
}
async function excluirLancamento(id) {
  return comTrava(async () => {
    const dados = await lerTudo(), l = dados.lancamentos.find(x => x.id === id);
    if (!l) throw ERRO("não encontrado", 404);
    l.excluido = agoraISO(); await gravarTudo(dados); return {ok: true};
  });
}
async function salvarEmpresa(corpo) {
  return comTrava(async () => {
    const nome = String(corpo.nome || "").trim().slice(0, 60);
    if (!nome) throw ERRO("Falta o nome da empresa");
    const dados = await lerTudo(); dados.config.empresa.nome = nome; await gravarTudo(dados); return dados.config.empresa;
  });
}
async function salvarLogo(foto) {
  return comTrava(async () => {
    let blob; try { blob = await redimensionar(await dataUrlParaBlob(foto), 512, 0.92); } catch { throw ERRO("imagem inválida"); }
    // a logo guarda a transparência (PNG): refaz em PNG
    const png = await new Promise((ok, er) => { const img = new Image(), u = URL.createObjectURL(blob); img.onload = () => { const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext("2d").drawImage(img, 0, 0); URL.revokeObjectURL(u); c.toBlob(ok, "image/png"); }; img.onerror = er; img.src = u; });
    const orig = await dataUrlParaBlob(foto); const usar = orig.type === "image/png" ? await redimensionarPNG(orig, 512) : png;
    await fotoSet("__logo", {full: usar, mini: usar});
    const dados = await lerTudo(); dados.config.empresa.logo_v = Math.floor(Date.now() / 1000); await gravarTudo(dados);
    await atualizarLogoUrl(); return dados.config.empresa;
  });
}
function redimensionarPNG(blob, max) {
  return new Promise((ok, er) => {
    const url = URL.createObjectURL(blob), img = new Image();
    img.onload = () => { const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); c.toBlob(ok, "image/png"); };
    img.onerror = er; img.src = url;
  });
}
async function removerLogo() {
  return comTrava(async () => {
    await fotoDel("__logo"); const dados = await lerTudo(); dados.config.empresa.logo_v = 0; await gravarTudo(dados); await atualizarLogoUrl(); return dados.config.empresa;
  });
}

// ------------------------------------------------------------------ estado, instalar, entrar
async function estado() {
  const dados = await lerTudo(), inst = !!(await kvGet("auth")), logado = inst && await sessaoOk();
  await atualizarLogoUrl();
  const meta = (await kvGet("meta")) || {};
  const est = {instalado: inst, logado, empresa: {nome: dados.config.empresa.nome || "", logo_v: dados.config.empresa.logo_v}, pode_instalar: true, tem_dados: dados.jobs.length > 0, pasta_ia_padrao: "", local: true, ultimo_backup: meta.ultimo_backup || null};
  if (logado) est.email = (await kvGet("auth")).email || "";
  return est;
}
async function instalar(corpo) {
  if (await kvGet("auth")) throw ERRO("O app já está instalado");
  const nome = String(corpo.nome || "").trim().slice(0, 60);
  if (!nome) throw ERRO("Falta o nome da empresa");
  const email = String(corpo.email || "").trim().slice(0, 120);
  if (!RE_EMAIL.test(email)) throw ERRO("E-mail inválido");
  const senha = checarSenhaNova(corpo.senha, corpo.senha2);
  const sal = crypto.getRandomValues(new Uint8Array(16));
  await kvSet("auth", {email, sal: hex(sal), iter: ITER, hash: await pbkdf2(senha, sal), criado: agoraISO()});
  await comTrava(async () => { const d = await lerTudo(); d.config.empresa.nome = nome; await gravarTudo(d); });
  await novaSessao();
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch {}
  return {ok: true};
}
async function trocarSenha(atual, nova, nova2) {
  await conferirComLimite(atual); const senha = checarSenhaNova(nova, nova2);
  const a = await kvGet("auth"), sal = crypto.getRandomValues(new Uint8Array(16));
  Object.assign(a, {sal: hex(sal), iter: ITER, hash: await pbkdf2(senha, sal)}); await kvSet("auth", a);
  await kvSet("sessoes", {}); await novaSessao(); return {ok: true};
}
async function trocarEmail(atual, email) {
  await conferirComLimite(atual); email = String(email || "").trim().slice(0, 120);
  if (!RE_EMAIL.test(email)) throw ERRO("E-mail inválido");
  const a = await kvGet("auth"); a.email = email; await kvSet("auth", a); return {email};
}
async function apagarTudo(senha, confirmacao, semSenha = false) {
  if (String(confirmacao || "") !== "APAGAR") throw ERRO("Digite APAGAR para confirmar");
  if (!semSenha) await conferirComLimite(senha);
  await comTrava(async () => {
    if (STORE) await STORE.apagarTudo();
    else {
      if (_db) { _db.close(); _db = null; }
      await new Promise(ok => { const r = indexedDB.deleteDatabase("receitas-despesas"); r.onsuccess = r.onerror = r.onblocked = () => ok(); });
    }
  });
  for (const k of Object.keys(localStorage)) if (k.startsWith("rd-") && k !== "rd-lang") localStorage.removeItem(k);
  for (const k of Object.keys(MINI)) { URL.revokeObjectURL(MINI[k]); delete MINI[k]; }
  for (const k of Object.keys(_full)) { URL.revokeObjectURL(_full[k]); delete _full[k]; }
  _logoUrl = ""; api.logoUrl = "";
  return {ok: true};
}

// ------------------------------------------------------------------ contas (iguais às do servidor)
function contasDoJob(dados, j) {
  const ds = dados.lancamentos.filter(l => !l.excluido && l.job_id === j.id), t = truckDoJob(j, dados.config);
  const lancadas = r2(ds.reduce((s, l) => s + l.valor, 0)), total = r2(lancadas + t.total), receita = j.receita || 0, lucro = r2(receita - total);
  const horas = (j.dias_trabalhados || 0) * (j.horas_dia || 0) * (j.pessoas || 0), sqft = j.sqft || 0, porItem = {};
  for (const l of ds) porItem[l.item] = (porItem[l.item] || 0) + l.valor;
  if (t.total) porItem[ITEM_TRUCK] = (porItem[ITEM_TRUCK] || 0) + t.total;
  const pct = v => receita ? r2(v / receita * 100, 1) : null;
  return {
    id: j.id, nome: j.nome, cidade: j.cidade || "", endereco: j.endereco || "", status: j.status || "aberto",
    valor_do_trabalho: receita, despesas_lancadas: lancadas, truck_estimado: r2(t.total), despesas_total: total,
    despesas_percentual: pct(total), lucro, lucro_percentual: pct(lucro),
    sqft: sqft || null, milhas_so_ida: j.milhas || null, idas_roberto: j.idas_dono || 0, dias_work_truck: j.dias_work || 0,
    data_inicio: j.data_inicio || null, data_fim: j.data_fim || null, dias_trabalhados: j.dias_trabalhados || null,
    horas_por_dia: horas ? j.horas_dia : null, pessoas: j.pessoas || null, horas_totais: horas ? r2(horas) : null,
    horas_por_sqft: horas && sqft ? r2(horas / sqft, 3) : null, sqft_por_hora: horas && sqft ? r2(sqft / horas) : null,
    price_por_sqft: sqft && receita ? r2(receita / sqft) : null, custo_por_sqft: sqft ? r2(total / sqft) : null, lucro_por_sqft: sqft ? r2(lucro / sqft) : null,
    price_por_hora: horas && receita ? r2(receita / horas) : null, lucro_por_hora: horas ? r2(lucro / horas) : null,
    despesas_por_item: Object.entries(porItem).sort((a, b) => b[1] - a[1]).map(([item, v]) => ({item, valor: r2(v), percentual_do_valor_do_trabalho: pct(v)})),
  };
}

// ------------------------------------------------------------------ square footage e distância (dados públicos)
const CENSO = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const PARCELAS = "https://services1.arcgis.com/hGdibHYSPO59RG1h/arcgis/rest/services/Massachusetts_Property_Tax_Parcels/FeatureServer/0/query";
const CAMPOS_PARCELA = "SITE_ADDR,ADDR_NUM,FULL_STR,CITY,BLD_AREA,RES_AREA,YEAR_BUILT,STORIES,USE_DESC,FY";
const FATOR_ESTRADA = 1.3;
function jsonp(url) {
  return new Promise((ok, er) => {
    const cb = "rdcb" + Math.random().toString(36).slice(2), s = document.createElement("script");
    const t = setTimeout(() => { limpar(); er(new Error("rede")); }, 20000);
    const limpar = () => { clearTimeout(t); delete window[cb]; s.remove(); };
    window[cb] = d => { limpar(); ok(d); };
    s.onerror = () => { limpar(); er(new Error("rede")); };
    s.src = url + (url.includes("?") ? "&" : "?") + "callback=" + cb; document.head.appendChild(s);
  });
}
async function arcgis(params) {
  const r = await fetch(PARCELAS + "?" + new URLSearchParams(params)); if (!r.ok) throw new Error("rede"); return r.json();
}
async function geocodificar(linha) {
  const cache = JSON.parse(localStorage.getItem("rd-geo") || "{}");
  if (linha in cache) return cache[linha];
  const g = await jsonp(CENSO + "?" + new URLSearchParams({address: linha, benchmark: "Public_AR_Current", format: "jsonp"}));
  const a = g.result.addressMatches, r = a.length ? [a[0].coordinates.x, a[0].coordinates.y] : null;
  cache[linha] = r; try { localStorage.setItem("rd-geo", JSON.stringify(cache)); } catch {}
  return r;
}
function milhasReta([lon1, lat1], [lon2, lat2]) {
  const rad = x => x * Math.PI / 180, p1 = rad(lat1), p2 = rad(lat2);
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}
const centro = rings => { const pts = (rings || []).slice(0, 1).flat(); return pts.length ? [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length] : null; };
async function parcelaPorTexto(num, palavra, cidade) {
  num = num.replace(/\D/g, ""); palavra = palavra.replace(/[^A-Za-z0-9]/g, "").toUpperCase(); cidade = cidade.replace(/[^A-Za-z ]/g, "").toUpperCase().trim();
  if (!num || !palavra) return null;
  let where = `ADDR_NUM='${num}' AND UPPER(FULL_STR) LIKE '${palavra}%'`;
  if (cidade) where += ` AND (CITY='${cidade}' OR UPPER(SITE_ADDR) LIKE '%${cidade}%')`;
  const d = await arcgis({where, outFields: CAMPOS_PARCELA, returnGeometry: "true", outSR: 4326, resultRecordCount: 5, f: "json"});
  const fs = d.features || []; if (fs.length !== 1) return null;
  return [fs[0].attributes, centro((fs[0].geometry || {}).rings)];
}
async function buscarSqft(endereco, cidade) {
  endereco = String(endereco || "").trim().slice(0, 160); cidade = String(cidade || "").trim().slice(0, 40);
  if (!endereco) throw ERRO("falta o endereço");
  const mNum = endereco.match(/^\s*(\d+)/), num = mNum ? mNum[1] : null;
  const rua = endereco.replace(/^\s*\d+\s*/, "").split(",")[0].toLowerCase().replace(/[^a-z0-9 ]/g, "");
  const out = {achou: false, motivo: "parcela"};
  let a = null, coord = null, confere = false;
  try { const achado = num && rua ? await parcelaPorTexto(num, rua.split(" ")[0] || "", cidade) : null; if (achado) { [a, coord] = achado; confere = true; } } catch {}
  if (!a) {
    let linha = endereco;
    if (cidade && !linha.toLowerCase().includes(cidade.toLowerCase())) linha += ", " + cidade;
    if (!/\bMA\b|massachusetts/i.test(linha)) linha += ", MA";
    try { coord = await geocodificar(linha); } catch { return {achou: false, motivo: "rede"}; }
    if (!coord) return {achou: false, motivo: "endereco"};
    const parcelasEm = async raio => {
      const p = {geometry: `${coord[0]},${coord[1]}`, geometryType: "esriGeometryPoint", inSR: 4326, spatialRel: "esriSpatialRelIntersects", outFields: CAMPOS_PARCELA, returnGeometry: "false", f: "json"};
      if (raio) { p.distance = raio; p.units = "esriSRUnit_Meter"; }
      return ((await arcgis(p)).features || []).map(f => f.attributes);
    };
    const bate = x => !!num && String(x.ADDR_NUM || "").trim() === num && rua.includes(String(x.FULL_STR || "").toLowerCase().split(" ")[0]);
    try {
      const ps = await parcelasEm(0);
      a = ps.find(bate) || (await parcelasEm(80)).find(bate) || null; confere = !!a;
      if (!a && ps.length) a = ps.reduce((m, x) => ((x.RES_AREA || 0) > (m.RES_AREA || 0) ? x : m), ps[0]);
    } catch { out.motivo = "rede"; }
  }
  if (coord) {
    try {
      const base = (await lerTudo()).config.base;
      const cb = base ? await geocodificar(base) : null;
      if (cb) { const reta = milhasReta(cb, coord); out.milhas_reta = r2(reta, 1); out.milhas_estimadas = r2(reta * FATOR_ESTRADA, 1); }
    } catch {}
  }
  if (!a) return out;
  const moradia = parseInt(a.RES_AREA || 0), total = parseInt(a.BLD_AREA || 0);
  if (!moradia && !total) { out.motivo = "sem_area"; return out; }
  const titulo = s => String(s || "").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  Object.assign(out, {achou: true, motivo: null, confere, endereco_oficial: titulo(a.SITE_ADDR), cidade: titulo(a.CITY), sq_moradia: moradia, sq_total: total,
    ano: a.YEAR_BUILT || null, andares: a.STORIES || null, uso: a.USE_DESC || "", fy: a.FY || null});
  return out;
}

// ------------------------------------------------------------------ leitor de recibo no próprio aparelho (Tesseract, sem internet)
const _libs = {};
function carregarScript(src) {
  return _libs[src] || (_libs[src] = new Promise((ok, er) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => er(new Error("falha ao carregar " + src)); document.head.appendChild(s); }));
}
const abs = rel => new URL(rel, document.baseURI).href;
let _ocr = null;
async function ocrWorker() {
  if (_ocr) return _ocr;
  await carregarScript("vendor/tesseract/tesseract.min.js");
  _ocr = Tesseract.createWorker("eng", 1, {workerPath: abs("vendor/tesseract/worker.min.js"), corePath: abs("vendor/tesseract/"), langPath: abs("vendor/tesseract/"), gzip: true, workerBlobURL: false, cacheMethod: "none"});
  return _ocr;
}
async function prepararParaOCR(dataUrl) {
  const blob = await dataUrlParaBlob(dataUrl), url = URL.createObjectURL(blob), img = new Image();
  await new Promise((ok, er) => { img.onload = ok; img.onerror = er; img.src = url; });
  const k = Math.min(2, 2000 / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
  const g = c.getContext("2d"); g.drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
  const im = g.getImageData(0, 0, c.width, c.height), d = im.data, hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) { const y = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); d[i] = d[i + 1] = d[i + 2] = y; hist[y]++; }
  const n = c.width * c.height; let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > n * 0.02) { lo = v; break; } }
  acc = 0; for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > n * 0.02) { hi = v; break; } }
  const esc = hi > lo + 10 ? 255 / (hi - lo) : 1;
  for (let i = 0; i < d.length; i += 4) { const y = Math.max(0, Math.min(255, (d[i] - lo) * esc)); d[i] = d[i + 1] = d[i + 2] = y; }
  g.putImageData(im, 0, 0); return c;
}
const valoresDe = txt => [...txt.matchAll(RE_DINHEIRO)].map(m => parseFloat(m[1].replace(/,/g, "") + "." + m[2]));
function acharTotal(linhas) {
  const baixo = linhas.map(l => l.toLowerCase()), ruins = ["sub", "tax", "change", "troco", "saving", "discount", "desconto", "tip"];
  for (const chaves of [["total"], ["amount due", "balance due", "total due", "amount"], ["visa", "mastercard", "amex", "debit", "credit", "card"]]) {
    let achados = [];
    baixo.forEach((l, i) => { if (chaves.some(c => l.includes(c)) && !ruins.some(r => l.includes(r))) { const v = valoresDe(linhas[i]); achados = achados.concat(v.length ? v : (i + 1 < linhas.length ? valoresDe(linhas[i + 1]) : [])); } });
    if (achados.length) return Math.max(...achados);
  }
  const todos = linhas.flatMap(valoresDe); return todos.length ? Math.max(...todos) : null;
}
async function lerRecibo(foto) {
  try {
    const w = await ocrWorker(), canvas = await prepararParaOCR(foto);
    const {data} = await w.recognize(canvas);
    const linhas = String(data.text || "").split("\n").map(l => l.trim()).filter(Boolean);
    const loja = linhas.find(l => /[A-Za-z]{3}/.test(l) && !valoresDe(l).length) || "";
    return {valor: acharTotal(linhas), loja: loja.slice(0, 60), linhas: linhas.slice(0, 60)};
  } catch (e) { return {valor: null, loja: "", erro: String(e && e.message || e)}; }
}

// ------------------------------------------------------------------ exportações (Excel, pacote para IA, backup) e entrega por Compartilhar/Arquivos
const IDX = {pt: 0, en: 1, es: 2};
const XL = {
  resumo: ["Resumo", "Summary", "Resumen"], todos: ["Todos os jobs", "All jobs", "Todos los trabajos"],
  titulo_xl: ["Receitas e Despesas · {n}", "Revenue and Expenses · {n}", "Ingresos y Gastos · {n}"],
  fonte_xl: ["Fonte: lançamentos do app Receitas e Despesas. Gerado em {d}.", "Source: entries from the Revenue and Expenses app. Generated {d}.", "Fuente: registros de la app Ingresos y Gastos. Generado el {d}."],
  k_rec: ["Receita (valor dos trabalhos)", "Revenue (job values)", "Ingresos (valor de los trabajos)"], k_desp: ["Despesas", "Expenses", "Gastos"], k_sob: ["Sobrou", "Left over", "Sobró"],
  gasto_rec: ["Gasto sobre a receita", "Spending vs. revenue", "Gasto sobre los ingresos"],
  h_item: ["Item", "Item", "Concepto"], h_valor: ["Valor", "Amount", "Monto"], h_pdesp: ["% das despesas", "% of expenses", "% de los gastos"], h_prec: ["% do valor do trabalho", "% of job value", "% del valor del trabajo"],
  j_job: ["Job", "Job", "Trabajo"], j_cheque: ["Valor do trabalho", "Job value", "Valor del trabajo"], j_lucro: ["% lucro", "% profit", "% ganancia"], j_sqft: ["Sq ft", "Sq ft", "Sq ft"],
  j_cheque_sq: ["$ Price/sq ft", "$ Price/sq ft", "$ Price/sq ft"], j_custo_sq: ["Custo/sq ft", "Cost/sq ft", "Costo/sq ft"], j_lucro_sq: ["Lucro/sq ft", "Profit/sq ft", "Ganancia/sq ft"],
  j_horas: ["Horas totais", "Total hours", "Horas totales"], j_pessoas: ["Pessoas", "People", "Personas"], j_hsq: ["Horas/sq ft", "Hours/sq ft", "Horas/sq ft"], j_sqh: ["Sq ft/hora", "Sq ft/hour", "Sq ft/hora"],
  j_price_h: ["$ Price/hora", "$ Price/hour", "$ Price/hora"], j_lucro_h: ["Lucro/hora", "Profit/hour", "Ganancia/hora"], j_ini: ["Início", "Start", "Inicio"], j_fim: ["Fim", "End", "Fin"],
  t_titulo: ["Truck (estimativa)", "Truck (estimate)", "Truck (estimación)"], t_milhas: ["Milhas", "Miles", "Millas"], t_dono: ["Truck do dono", "Owner's truck", "Truck del dueño"], t_work: ["Work truck", "Work truck", "Work truck"], t_total: ["Total", "Total", "Total"],
  n_dono: ["truck do dono", "owner's truck", "truck del dueño"], n_work: ["work truck", "work truck", "work truck"],
  veic_txt: ["{m} {mpg} MPG a ${p}/galão", "{m} {mpg} MPG at ${p}/gallon", "{m} {mpg} MPG a ${p}/galón"], gas_nota: ["Gasolina ${p}/galão ({d}); {v}.", "Gas ${p}/gallon ({d}); {v}.", "Gasolina ${p}/galón ({d}); {v}."],
  sem_data: ["sem data", "no date", "sin fecha"], chart: ["Despesas por item", "Expenses by item", "Gastos por concepto"], sheet_desp: ["Despesas", "Expenses", "Gastos"],
  d_data: ["Data", "Date", "Fecha"], d_desc: ["Descrição", "Description", "Descripción"], d_loja: ["Loja", "Store", "Tienda"], d_foto: ["Foto", "Photo", "Foto"],
};
const ITENS_XL = {
  "Labor": ["Labor", "Labor", "Mano de obra"], "Tinta": ["Tinta", "Paint", "Pintura"], "Material": ["Material", "Materials", "Materiales"], "Combustível": ["Combustível", "Fuel", "Combustible"],
  "Azek e madeira": ["Azek e madeira", "Azek and wood", "Azek y madera"], "Ferramentas": ["Ferramentas", "Tools", "Herramientas"], "Alimentação": ["Alimentação", "Meals", "Comidas"], "Outros": ["Outros", "Other", "Otros"],
  "Truck (estimativa)": ["Truck (estimativa)", "Truck (estimate)", "Truck (estimación)"], "Sub-contrato": ["Sub-contrato", "Subcontract", "Subcontrato"],
};
async function exportarExcel(jobId, lang) {
  await carregarScript("vendor/exceljs.min.js");
  const L = IDX[lang] ?? 0, X = (k, kw = {}) => XL[k][L].replace(/\{(\w+)\}/g, (_, n) => kw[n] ?? ""), tr = n => (ITENS_XL[n] || [n, n, n])[L];
  const dados = await lerTudo(), cfg = dados.config, jobs = dados.jobs.filter(j => !jobId || j.id === jobId);
  if (!jobs.length) throw ERRO("job não encontrado", 404);
  const ids = new Set(jobs.map(j => j.id));
  const lancs = dados.lancamentos.filter(l => !l.excluido && ids.has(l.job_id)).sort((a, b) => (a.data + (a.criado || "")).localeCompare(b.data + (b.criado || "")));
  const nomeJob = Object.fromEntries(jobs.map(j => [j.id, j.nome])), gasto = Object.fromEntries(jobs.map(j => [j.id, 0])), porItem = {};
  for (const l of lancs) { gasto[l.job_id] += l.valor; porItem[l.item] = (porItem[l.item] || 0) + l.valor; }
  const trucks = Object.fromEntries(jobs.map(j => [j.id, truckDoJob(j, cfg)]));
  for (const j of jobs) { const t = trucks[j.id]; if (t.total) { gasto[j.id] += t.total; porItem[ITEM_TRUCK] = (porItem[ITEM_TRUCK] || 0) + t.total; } }
  const receita = jobs.reduce((s, j) => s + j.receita, 0), despesa = Object.values(gasto).reduce((s, v) => s + v, 0);
  const navy = "FF1A232F", red = "FFC83028", cinza = "FF5E6B7A";
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet(X("resumo"));
  const titulo = jobId ? jobs[0].nome : X("todos"), empresa = cfg.empresa.nome || "";
  ws.getCell("A1").value = `${empresa} · ` + X("titulo_xl", {n: titulo}); ws.getCell("A1").font = {size: 18, bold: true, color: {argb: navy}, name: "Arial"};
  const d = new Date(), pad = n => String(n).padStart(2, "0");
  const dataTxt = lang === "en" ? `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}` : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  ws.getCell("A2").value = X("fonte_xl", {d: dataTxt + " " + d.toLocaleTimeString("en-US", {hour: "2-digit", minute: "2-digit"})}); ws.getCell("A2").font = {size: 9, color: {argb: cinza}, name: "Arial"};
  [[X("k_rec"), receita, navy], [X("k_desp"), despesa, red], [X("k_sob"), receita - despesa, navy]].forEach(([rot, val, cor], i) => {
    ws.getCell(4, 1 + i).value = rot; ws.getCell(4, 1 + i).font = {size: 10, color: {argb: cinza}, name: "Arial"};
    const c = ws.getCell(5, 1 + i); c.value = r2(val); c.numFmt = '"$"#,##0.00'; c.font = {size: 16, bold: true, color: {argb: cor}, name: "Arial"};
  });
  ws.getCell("A7").value = X("gasto_rec"); ws.getCell("B7").value = receita ? despesa / receita : 0; ws.getCell("B7").numFmt = "0.0%"; ws.getCell("B7").font = {bold: true, color: {argb: red}, name: "Arial"};
  const din = '"$"#,##0.00', pct = "0.0%";
  const tabela = (linha, cab, linhas) => {
    cab.forEach((t, j) => { const c = ws.getCell(linha, 1 + j); c.value = t; c.font = {color: {argb: "FFFFFFFF"}, bold: true, name: "Arial"}; c.fill = {type: "pattern", pattern: "solid", fgColor: {argb: navy}}; });
    for (const vals of linhas) { linha++; vals.forEach(([v, fmt], j) => { const c = ws.getCell(linha, 1 + j); c.value = v; if (fmt) c.numFmt = fmt; }); }
    return linha;
  };
  const iniItem = 9, fimItem = tabela(iniItem, [X("h_item"), X("h_valor"), X("h_pdesp"), X("h_prec")],
    Object.entries(porItem).sort((a, b) => b[1] - a[1]).map(([it, v]) => [[tr(it)], [r2(v), din], [despesa ? v / despesa : 0, pct], [receita ? v / receita : 0, pct]]));
  const horasJob = j => (j.dias_trabalhados || 0) * (j.horas_dia || 0) * (j.pessoas || 0);
  const porSq = (v, j) => j.sqft ? [r2(v / j.sqft), din] : [""], porHora = (v, j) => horasJob(j) ? [r2(v / horasJob(j)), din] : [""];
  const usData = v => v ? `${v.slice(5, 7)}/${v.slice(8, 10)}/${v.slice(0, 4)}` : "";
  const fim = tabela(fimItem + 2, [X("j_job"), X("j_cheque"), X("k_desp"), X("k_sob"), X("j_lucro"), X("j_sqft"), X("j_cheque_sq"), X("j_custo_sq"), X("j_lucro_sq"), X("j_ini"), X("j_fim"), X("j_horas"), X("j_pessoas"), X("j_hsq"), X("j_sqh"), X("j_price_h"), X("j_lucro_h")],
    jobs.map(j => { const g = gasto[j.id], h = horasJob(j); return [[j.nome], [j.receita, din], [r2(g), din], [r2(j.receita - g), din], [j.receita ? (j.receita - g) / j.receita : 0, pct], [j.sqft || "", "#,##0"], porSq(j.receita, j), porSq(g, j), porSq(j.receita - g, j),
      [usData(j.data_inicio)], [usData(j.data_fim)], [h || "", "#,##0.#"], [j.pessoas || ""], [h && j.sqft ? h / j.sqft : "", "0.000"], [h && j.sqft ? j.sqft / h : "", "0.0"], porHora(j.receita, j), porHora(j.receita - g, j)]; }));
  const comTruck = jobs.filter(j => trucks[j.id].total);
  let ultima = fim;
  if (comTruck.length) {
    const f = tabela(fim + 2, [X("t_titulo"), X("t_milhas"), X("t_dono"), X("t_work"), X("t_total")], comTruck.map(j => { const t = trucks[j.id]; return [[j.nome], [t.mi_dono + t.mi_work, "#,##0"], [t.dono, din], [t.work, din], [t.total, din]]; }));
    const veic = [["dono", "n_dono"], ["work", "n_work"]].map(([k, nk]) => X("veic_txt", {m: cfg.veiculos[k].modelo || X(nk), mpg: cfg.veiculos[k].mpg, p: precoGasolina(cfg, k).toFixed(3)})).join("; ");
    ws.getCell(f + 1, 1).value = X("gas_nota", {p: cfg.gasolina.toFixed(3), d: cfg.gasolina_data || X("sem_data"), v: veic}); ws.getCell(f + 1, 1).font = {size: 9, color: {argb: cinza}, name: "Arial"};
    ultima = f + 1;
  }
  [28, 16, 16, 14, 12, 10, 13, 13, 13, 12, 12, 13, 10, 12, 12, 13, 13].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  // gráfico de barras (imagem) por item
  const itens = Object.entries(porItem).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (itens.length) {
    const cv = document.createElement("canvas"); cv.width = 760; cv.height = 60 + itens.length * 34; const g = cv.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height); g.fillStyle = "#1A232F"; g.font = "bold 18px Arial"; g.fillText(X("chart"), 12, 28);
    const max = itens[0][1]; itens.forEach(([it, v], i) => { const y = 50 + i * 34; g.fillStyle = "#5E6B7A"; g.font = "14px Arial"; g.fillText(tr(it), 12, y + 16); g.fillStyle = "#C83028"; g.fillRect(190, y, Math.max(2, (v / max) * 440), 22); g.fillStyle = "#1A232F"; g.fillText("$" + v.toFixed(2), 190 + Math.max(2, (v / max) * 440) + 8, y + 16); });
    ws.addImage(wb.addImage({base64: cv.toDataURL("image/png"), extension: "png"}), {tl: {col: 0, row: ultima + 3}, ext: {width: cv.width, height: cv.height}});
  }
  if (_logoUrl) { const lb = (await fotoGet("__logo")).full; const b64 = await new Promise(ok => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(lb); }); ws.addImage(wb.addImage({base64: b64, extension: "png"}), {tl: {col: 8, row: 0}, ext: {width: 58, height: 58}}); }
  const wl = wb.addWorksheet(X("sheet_desp"));
  [X("d_data"), X("j_job"), X("h_item"), X("d_desc"), X("d_loja"), X("h_valor"), X("d_foto")].forEach((t, j) => { const c = wl.getCell(1, 1 + j); c.value = t; c.font = {color: {argb: "FFFFFFFF"}, bold: true, name: "Arial"}; c.fill = {type: "pattern", pattern: "solid", fgColor: {argb: navy}}; });
  [12, 22, 16, 40, 22, 13, 14].forEach((w, i) => { wl.getColumn(i + 1).width = w; });
  let i = 2;
  for (const l of lancs) {
    wl.getCell(i, 1).value = usData(l.data); wl.getCell(i, 2).value = nomeJob[l.job_id]; wl.getCell(i, 3).value = tr(l.item); wl.getCell(i, 4).value = l.descricao || ""; wl.getCell(i, 5).value = l.loja || "";
    const v = wl.getCell(i, 6); v.value = l.valor; v.numFmt = din; v.font = {color: {argb: red}, bold: true, name: "Arial"};
    const f = l.foto ? await fotoGet(l.foto) : null;
    if (f) { const b64 = await new Promise(ok => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(f.mini); }); wl.addImage(wb.addImage({base64: b64, extension: "jpeg"}), {tl: {col: 6, row: i - 1}, ext: {width: 90, height: 90}}); wl.getRow(i).height = 70; } else wl.getRow(i).height = 22;
    i++;
  }
  const buf = await wb.xlsx.writeBuffer();
  const base = (jobId ? jobs[0].nome : X("todos")).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "job";
  return {blob: new Blob([buf], {type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}), nome: `receitas-despesas-${base}-${hojeISO()}-${lang in IDX ? lang : "pt"}.xlsx`};
}

const LEIA_ME_IA = `# Receitas e Despesas: dados para IA / data for AI

Gerado em / generated at: {gerado}
Empresa / company: {empresa}  ·  Moeda / currency: USD  ·  Esquema / schema: v1

## Português
Este pacote tem os dados do app Receitas e Despesas em arquivos abertos. Uma IA pode ler tudo sem precisar do app.
- \`empresa.json\`: nome da empresa, base (endereço de saída), preço da gasolina e trucks (MPG, outros gastos por milha).
- \`jobs.json\` e \`jobs.csv\`: um registro por job, com as contas já feitas.
- \`despesas.json\` e \`despesas.csv\`: uma linha por despesa (a despesa excluída no app não aparece aqui).
- \`fotos/\`: foto do recibo de cada despesa (campo \`foto\` aponta o arquivo).

### Como ler os campos de \`jobs\`
- \`valor_do_trabalho\` = receita do job (100%).
- \`despesas_lancadas\` = soma das despesas com recibo, labor e sub-contrato lançados.
- \`truck_estimado\` = estimativa de gasolina e uso dos trucks: (idas do dono × 2 × milhas × custo por milha do truck dele) + (dias do work truck × 2 × milhas × custo por milha do work truck). Custo por milha = preço da gasolina ÷ MPG + outros gastos por milha.
- \`despesas_total\` = \`despesas_lancadas\` + \`truck_estimado\`.
- \`lucro\` = \`valor_do_trabalho\` − \`despesas_total\`. \`lucro_percentual\` = lucro ÷ valor do trabalho × 100. Abaixo de 20% é alerta.
- \`horas_totais\` = \`dias_trabalhados\` × \`horas_por_dia\` × \`pessoas\`.
- \`horas_por_sqft\`, \`sqft_por_hora\`, \`price_por_sqft\`, \`custo_por_sqft\`, \`lucro_por_sqft\`, \`price_por_hora\`, \`lucro_por_hora\`: só existem se houver sq ft ou horas.
- \`despesas_por_item\`: cada item (Labor, Sub-contrato, Tinta, Material...) com valor e % do valor do trabalho. Os nomes dos itens estão em português.

### Regras
- Dinheiro em dólares americanos. Datas AAAA-MM-DD.
- Estes números são do próprio dono; não envie a ninguém sem a autorização dele.

## English
This package holds the Revenue and Expenses app data as open files so any AI can read it without the app.
\`valor_do_trabalho\` = job value (100%). \`despesas_total\` = recorded expenses + estimated truck cost. \`lucro\` = job value − total expenses; \`lucro_percentual\` below 20% is a warning. \`horas_totais\` = worked days × hours per day × people. Item names are in Portuguese (Labor, Sub-contrato = subcontract, Tinta = paint, Material, Combustível = fuel, Alimentação = meals, Outros = other). Money is USD; dates are YYYY-MM-DD. These numbers belong to the owner: do not share without permission.
`;
const csv = (campos, linhas) => [campos.join(",")].concat(linhas.map(l => campos.map(c => { const v = l[c]; if (v == null) return ""; const s = String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(","))).join("\r\n") + "\r\n";
async function gerarPacoteIA() {
  await carregarScript("vendor/jszip.min.js");
  const dados = await lerTudo(), cfg = dados.config, gerado = agoraISO();
  const jobs = dados.jobs.map(j => contasDoJob(dados, j)), nome = Object.fromEntries(dados.jobs.map(j => [j.id, j.nome]));
  const ds = dados.lancamentos.filter(l => !l.excluido && nome[l.job_id]).sort((a, b) => (a.data + (a.criado || "")).localeCompare(b.data + (b.criado || "")));
  const despesas = ds.map(l => ({id: l.id, job_id: l.job_id, job: nome[l.job_id], data: l.data, item: l.item, valor: l.valor, descricao: l.descricao || "", loja: l.loja || "", foto: l.foto ? "fotos/" + l.foto : null}));
  const topo = {versao_esquema: 1, gerado_em: gerado, empresa: cfg.empresa.nome, moeda: "USD"};
  const empresa = {...topo, base: cfg.base, gasolina_por_galao: cfg.gasolina, gasolina_data: cfg.gasolina_data || null, veiculos: Object.fromEntries(Object.entries(cfg.veiculos).map(([k, v]) => [k, {modelo: v.modelo, mpg: v.mpg, outros_gastos_por_milha: v.outros, gasolina_propria: v.gasolina || null}]))};
  const z = new JSZip();
  z.file("LEIA-ME.md", LEIA_ME_IA.replace("{gerado}", gerado).replace("{empresa}", cfg.empresa.nome));
  z.file("empresa.json", JSON.stringify(empresa, null, 1)); z.file("jobs.json", JSON.stringify({...topo, jobs}, null, 1)); z.file("despesas.json", JSON.stringify({...topo, despesas}, null, 1));
  const campos = jobs.length ? Object.keys(jobs[0]).filter(k => k !== "despesas_por_item") : ["id", "nome"];
  z.file("jobs.csv", csv(campos, jobs)); z.file("despesas.csv", csv(["id", "job_id", "job", "data", "item", "valor", "descricao", "loja", "foto"], despesas));
  for (const l of ds) if (l.foto) { const f = await fotoGet(l.foto); if (f) z.file("fotos/" + l.foto, f.full); }
  return {blob: await z.generateAsync({type: "blob", compression: "DEFLATE"}), nome: `receitas-despesas-para-ia-${hojeISO()}.zip`, jobs: jobs.length, despesas: despesas.length};
}
async function gerarBackup() {
  await carregarScript("vendor/jszip.min.js");
  const dados = await lerTudo(), z = new JSZip();
  z.file("lancamentos.json", JSON.stringify(dados, null, 1));
  const logo = await fotoGet("__logo"); if (logo) z.file("logo.png", logo.full);
  for (const k of await fotoChaves()) if (k !== "__logo") { const f = await fotoGet(k); if (f) z.file("fotos/" + k, f.full); }
  z.file("LEIA-ME-BACKUP.txt", "Backup do app Receitas e Despesas (sem senha: a senha nunca entra no backup).\nPara restaurar: Setup > Exportar dados > Restaurar backup.\n");
  const meta = (await kvGet("meta")) || {}; meta.ultimo_backup = hojeISO(); await kvSet("meta", meta);
  return {blob: await z.generateAsync({type: "blob", compression: "DEFLATE"}), nome: `backup-despesas-${hojeISO()}.zip`};
}
async function restaurarBackup(arquivo, senha) {
  await conferirComLimite(senha);
  await carregarScript("vendor/jszip.min.js");
  let z; try { z = await JSZip.loadAsync(arquivo); } catch { throw ERRO("Arquivo de backup inválido"); }
  const j = z.file("lancamentos.json"); if (!j) throw ERRO("Arquivo de backup inválido");
  let dados; try { dados = JSON.parse(await j.async("string")); } catch { throw ERRO("Arquivo de backup inválido"); }
  if (!Array.isArray(dados.jobs) || !Array.isArray(dados.lancamentos)) throw ERRO("Arquivo de backup inválido");
  return comTrava(async () => {
    const atual = await lerTudo(); dados.config = configCompleta(dados.config);
    dados.config.empresa = {...dados.config.empresa, logo_v: atual.config.empresa.logo_v};   // a logo atual fica (o logo do backup só vem se houver)
    for (const nome of Object.keys(z.files)) {
      if (/^fotos\/[A-Za-z0-9-]{8,64}\.jpg$/.test(nome)) { const blob = await z.file(nome).async("blob"); const b = new Blob([blob], {type: "image/jpeg"}); const id = nome.slice(6); await fotoSet(id, {full: b, mini: await redimensionar(b, 240, 0.7)}); delete MINI[id]; delete _full[id]; }
      else if (nome === "logo.png") { const b = new Blob([await z.file(nome).async("blob")], {type: "image/png"}); await fotoSet("__logo", {full: b, mini: b}); dados.config.empresa.logo_v = Math.floor(Date.now() / 1000); }
    }
    await gravarTudo(dados); await atualizarLogoUrl();
    return {ok: true, jobs: dados.jobs.length, lancamentos: dados.lancamentos.length};
  });
}
async function entregar(res) {   // iPhone: abre o "Compartilhar" (Salvar em Arquivos, iCloud, AirDrop); senão baixa o arquivo
  const arq = new File([res.blob], res.nome, {type: res.blob.type});
  try { if (navigator.canShare && navigator.canShare({files: [arq]})) { await navigator.share({files: [arq]}); return {via: "compartilhar"}; } } catch (e) { if (e && e.name === "AbortError") return {via: "cancelado"}; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(res.blob); a.download = res.nome; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  return {via: "download"};
}

// ------------------------------------------------------------------ roteador (as mesmas rotas do servidor do Mac)
async function api(caminho, corpo) {
  const u = new URL(caminho, "http://x"), rota = u.pathname, q = u.searchParams, post = corpo !== undefined;
  if (rota === "/api/estado") return estado();
  if (rota === "/api/instalar") return instalar(corpo);
  if (rota === "/api/entrar") { if (!(await kvGet("auth"))) throw ERRO("O app ainda não foi instalado"); await conferirComLimite(corpo.senha); await novaSessao(); return {ok: true}; }
  if (!(await sessaoOk())) throw ERRO("Entre com a senha", 401);
  if (rota === "/api/sair") { await encerrarSessao(); return {ok: true}; }
  if (rota === "/api/senha") return trocarSenha(corpo.atual, corpo.nova, corpo.nova2);
  if (rota === "/api/email") return trocarEmail(corpo.atual, corpo.email);
  if (rota === "/api/empresa") return salvarEmpresa(corpo);
  if (rota === "/api/logo") return salvarLogo(corpo.foto);
  if (rota === "/api/logo/remover") return removerLogo();
  if (rota === "/api/config") return salvarConfig(corpo);
  if (rota === "/api/job") return salvarJob(corpo);
  if (rota === "/api/lancamento") return salvarLancamento(corpo);
  if (rota === "/api/excluir") return excluirLancamento(String(corpo.id || ""));
  if (rota === "/api/ler-recibo") return lerRecibo(corpo.foto || "");
  if (rota === "/api/apagar-tudo") return apagarTudo(corpo.senha, corpo.confirmacao);
  if (rota === "/api/lancamentos") {
    const d = await lerTudo(), ativos = d.lancamentos.filter(l => !l.excluido);
    await precarregarMinis(ativos);
    return {jobs: d.jobs, lancamentos: ativos, config: d.config, atualizado: d.atualizado};
  }
  if (rota === "/api/sqft") return buscarSqft(q.get("endereco"), q.get("cidade"));
  throw ERRO("não encontrado", 404);
}
api.logoUrl = "";
api.mini = nome => MINI[nome] || "";
api.fotoCompleta = fotoCompleta;
api.cheia = nome => _full[nome] || "";
api.baixar = async (qual, lang) => {   // "excel", "excel:JOBID", "backup", "ia"
  if (!(await sessaoOk())) throw ERRO("Entre com a senha", 401);
  if (qual === "backup") return entregar(await gerarBackup());
  if (qual === "ia") { const r = await gerarPacoteIA(); const e = await entregar(r); return {...e, jobs: r.jobs, despesas: r.despesas}; }
  const [, id] = qual.split(":"); return entregar(await exportarExcel(id || null, lang));
};
api.restaurar = restaurarBackup;
api.apagarSemSenha = confirmacao => apagarTudo("", confirmacao, true);   // "esqueci a senha": o dado nunca sai do aparelho
api.contasDoJob = contasDoJob;            // para os testes
api.lerTudo = lerTudo;
api.numero = numero;
api.ultimoBackup = async () => ((await kvGet("meta")) || {}).ultimo_backup || null;
window.RD_LOCAL = api;
})();
