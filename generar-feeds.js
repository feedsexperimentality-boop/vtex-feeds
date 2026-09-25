#!/usr/bin/env node
// Genera feeds de catálogo para Meta, Google Merchant Center, TikTok y Pinterest
// desde las APIs públicas de VTEX. No usa AppKey ni AppToken.
// Uso: node generar-feeds.js [slug] [--forzar]
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = __dirname;
const SALIDA = path.join(RAIZ, 'public');
const PAGINA = 50;
const LIMITE_VTEX = Number(process.env.LIMITE_VTEX) || 2500; // tope de _from/_to en Catalog Search
const UMBRAL_GRANDE = 2500; // desde aquí la tienda se actualiza una vez al día
const PARALELO = 4;
const PRECIO_MAXIMO = 1e9;
const MAX_IMAGENES = 4; // principal + 3 adicionales por SKU
const HISTORIAL = 30; // actualizaciones que se muestran en la app
const SIN_DECIMALES = ['COP', 'CLP', 'PYG', 'JPY', 'KRW'];

async function main() {
  const args = process.argv.slice(2);
  const forzar = args.includes('--forzar');
  const filtro = args.find((a) => !a.startsWith('--'));
  const tiendas = JSON.parse(fs.readFileSync(path.join(RAIZ, 'tiendas.json'), 'utf8'));
  fs.mkdirSync(SALIDA, { recursive: true });
  fs.writeFileSync(path.join(SALIDA, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  fs.writeFileSync(path.join(SALIDA, '.nojekyll'), '');

  // Las tiendas pequeñas van primero para que su actualización horaria no espere a las grandes.
  const pendientes = tiendas
    .filter((t) => t.activo !== false && (!filtro || t.slug === filtro))
    .map((t) => ({ t, previo: leerJson(path.join(SALIDA, t.slug, 'estado.json')) }))
    .sort((a, b) => productosPrevios(a.previo) - productosPrevios(b.previo));

  // --fase=pequenas / --fase=grandes permite publicar primero las tiendas pequeñas
  // para que una tienda grande no retrase su actualización horaria.
  const fase = (args.find((a) => a.startsWith('--fase=')) || '').split('=')[1] || '';
  let errores = 0;
  for (const { t, previo } of pendientes) {
    if (fase) {
      const tamano = previo ? productosPrevios(previo) : await contar(t, '').catch(() => 0);
      const grande = tamano >= UMBRAL_GRANDE;
      if ((fase === 'pequenas' && grande) || (fase === 'grandes' && !grande)) continue;
    }
    const horas = frecuenciaHoras(t, previo);
    if (!forzar && !tocaActualizar(previo, horas)) {
      console.log(`[${t.slug}] al día (se actualiza cada ${horas} h; última: ${previo.actualizado})`);
      continue;
    }
    try {
      await generarTienda(t, previo);
    } catch (error) {
      errores++;
      console.error(`[${t.slug}] ERROR: ${error.message}. Se conservan los feeds anteriores.`);
    }
  }
  escribirIndice(tiendas.filter((t) => t.activo !== false));
  if (errores) process.exitCode = 1;
}

// ---------- Página principal ----------

const FEEDS_INDICE = [
  ['meta', 'Meta', 'meta.csv'], ['tiktok', 'TikTok', 'tiktok.csv'],
  ['pinterest', 'Pinterest', 'pinterest.csv'], ['google', 'Google Merchant Center', 'google.xml'],
];

// El cron corre en el minuto 7 de cada hora; las tiendas diarias pueden correr desde las 23,5 h.
function proximaActualizacion(estado) {
  const horas = estado.frecuencia_horas || 1;
  const desde = Date.parse(estado.actualizado) + (horas > 1 ? horas * 3600e3 - 30 * 60e3 : 0);
  const proxima = new Date(desde);
  proxima.setUTCMinutes(7, 0, 0);
  if (proxima.getTime() <= desde) proxima.setTime(proxima.getTime() + 3600e3);
  return proxima.toISOString();
}

function textoCambios(c) {
  if (!c) return '—';
  if (c.primera_vez) return 'Primera publicación';
  const partes = [];
  if (c.modificados) partes.push(`${c.modificados} modificados`);
  if (c.nuevos) partes.push(`${c.nuevos} nuevos`);
  if (c.eliminados) partes.push(`${c.eliminados} retirados (agotados o despublicados)`);
  return partes.length ? partes.join(', ') : 'Sin cambios';
}

function escribirIndice(tiendas) {
  const repo = process.env.GITHUB_REPOSITORY || 'feedsexperimentality-boop/vtex-feeds';
  const [dueno, nombreRepo] = repo.split('/');
  const base = `https://${dueno}.github.io/${nombreRepo}`;
  const html = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const fecha = (iso) => `<time datetime="${html(iso)}">${html(iso)}</time>`;
  const numero = (n) => Number(n || 0).toLocaleString('es-CO');
  const estados = tiendas.map((t) => leerJson(path.join(SALIDA, t.slug, 'estado.json')));
  const totalPublicados = estados.reduce((s, e) => s + ((e && e.skus) || 0), 0);
  const ultima = estados.map((e) => e && e.actualizado).filter(Boolean).sort().pop();

  const tarjetas = tiendas.map((t, indice) => {
    const estado = estados[indice];
    const feeds = t.feeds || FEEDS_INDICE.map((f) => f[0]);
    const filas = FEEDS_INDICE.filter(([id]) => feeds.includes(id)).map(([id, nombre, archivo]) => {
      const url = `${base}/${t.slug}/${archivo}`;
      return `<div class="feed"><span class="plataforma"><i class="marca marca-${id}">${nombre[0]}</i>${nombre}</span>` +
        `<input readonly value="${html(url)}" aria-label="Enlace ${nombre}">` +
        `<button type="button" class="copiar" data-copiar="${html(url)}">Copiar</button></div>`;
    }).join('');
    const historial = (estado && estado.historial) || [];
    const frecuencia = estado && estado.frecuencia_horas > 1 ? 'Diaria' : 'Cada hora';
    const cuerpo = estado ? `
<div class="metricas">
  <div class="metrica"><span>Última actualización</span><strong>${fecha(estado.actualizado)}</strong></div>
  <div class="metrica"><span>Próxima (aprox.)</span><strong data-proxima="${html(proximaActualizacion(estado))}">${fecha(proximaActualizacion(estado))}</strong></div>
  <div class="metrica"><span>Cambios en el feed</span><strong>${textoCambios(estado.cambios)}</strong></div>
  <div class="metrica"><span>Encontrados en VTEX</span><strong>${numero(estado.skus_encontrados)} <small>SKUs · ${numero(estado.productos)} productos</small></strong></div>
  <div class="metrica destacada"><span>Publicados con stock</span><strong>${numero(estado.skus)}</strong></div>
  <div class="metrica"><span>Agotados · no se envían</span><strong>${numero(estado.agotados)}</strong></div>
</div>
${estado.incompletos ? `<p class="aviso">${numero(estado.incompletos)} SKUs con stock no se envían porque les falta imagen o precio en VTEX.</p>` : ''}
${impuestoMixto(estado.fuente_precio) ? `<p class="aviso">${numero(estado.fuente_precio.base)} SKUs llegan sin impuesto mientras el resto sí lo trae: revisa que su precio coincida con la tienda.</p>` : ''}
<div class="feeds">${filas}</div>
<div class="pie-tarjeta">
${historial.length ? `<details><summary>Historial de actualizaciones (${historial.length})</summary><div class="tabla"><table>
<thead><tr><th>Fecha</th><th>Encontrados</th><th>Publicados</th><th>Agotados</th><th>Cambios</th></tr></thead><tbody>
${historial.map((h) => `<tr><td>${fecha(h.fecha)}</td><td>${h.skus_encontrados == null ? '—' : numero(h.skus_encontrados)}</td>` +
  `<td>${numero(h.skus)}</td><td>${h.agotados == null ? '—' : numero(h.agotados)}</td><td>${textoCambios(h)}</td></tr>`).join('\n')}
</tbody></table></div></details>` : '<span></span>'}
<a class="tecnico" href="${base}/${t.slug}/estado.json" target="_blank">Estado técnico</a>
</div>`
      : `<p class="generando"><span class="punto"></span>Generando los feeds por primera vez. En catálogos grandes puede tardar varios minutos; los enlaces funcionarán cuando aparezca la fecha de actualización.</p>
<div class="feeds">${filas}</div>`;
    return `<section class="tienda" id="tienda-${html(t.slug)}" data-slug="${html(t.slug)}">
<header class="cabecera">
  <div><h2>${html(t.nombre)}</h2><a href="${html(t.dominio)}" target="_blank" rel="noopener">${html(t.dominio.replace(/^https?:\/\/(www\.)?/, ''))}</a></div>
  <div class="chips">${estado ? `<span class="chip">${frecuencia}</span><span class="chip estado" data-estado="${html(proximaActualizacion(estado))}">Al día</span>` : '<span class="chip gris">Generando</span>'}</div>
</header>${cuerpo}
</section>`;
  }).join('\n');

  // Lista lateral ordenada alfabéticamente; cada elemento abre el detalle de su tienda.
  const lista = tiendas.map((t, indice) => ({ t, estado: estados[indice] }))
    .sort((a, b) => a.t.nombre.localeCompare(b.t.nombre, 'es'))
    .map(({ t, estado }) => `<button type="button" class="item" data-abrir="${html(t.slug)}" data-buscar="${html(`${t.nombre} ${t.dominio} ${t.account}`.toLowerCase())}">
  <span class="luz${estado ? '' : ' gris'}"${estado ? ` data-estado="${html(proximaActualizacion(estado))}"` : ''}></span>
  <span class="item-texto"><strong>${html(t.nombre)}</strong><small>${estado ? `${numero(estado.skus)} SKUs · ${estado.frecuencia_horas > 1 ? 'Diaria' : 'Cada hora'}` : 'Generando…'}</small></span>
</button>`).join('\n');

  escribir(path.join(SALIDA, 'index.html'), `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Feeds VTEX · Experimentality</title>
<link rel="icon" href="https://www.experimentality.co/icon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root {
  --fondo:#f8f8f8; --tarjeta:#fff; --texto:#0a0a0a; --suave:#717171; --borde:#e5e5e5;
  --verde:#73d15b; --celeste:#0bbef0; --verde-texto:#2f8a1c; --verde-suave:#eef9ea;
  --degradado:linear-gradient(90deg, var(--verde) 0%, var(--celeste) 100%);
  --aviso:#9a6700; --aviso-fondo:#fff8e6; --error:#e40014; --error-fondo:#fdecee; --radio:10px;
}
* { box-sizing:border-box; }
body { margin:0; background:var(--fondo); color:var(--texto); font:15px/1.55 Poppins, ui-sans-serif, system-ui, sans-serif; }
a { color:inherit; }
.barra { background:rgba(255,255,255,.85); backdrop-filter:blur(8px); border-bottom:1px solid var(--borde); position:sticky; top:0; z-index:5; }
.barra-in { max-width:1040px; margin:0 auto; padding:14px 16px; display:flex; align-items:center; justify-content:space-between; gap:12px; }
.logo { display:flex; align-items:center; gap:12px; text-decoration:none; }
.logo img { height:30px; display:block; }
.logo span { font-size:13px; color:var(--suave); border-left:1px solid var(--borde); padding-left:12px; }
.boton { background:var(--degradado); color:#fff; text-decoration:none; font-weight:600; font-size:14px; padding:10px 18px; border-radius:8px; white-space:nowrap; box-shadow:0 6px 18px rgba(11,190,240,.22); transition:transform .15s, box-shadow .15s; }
.boton:hover { transform:translateY(-1px); box-shadow:0 10px 24px rgba(11,190,240,.3); }
main { max-width:1040px; margin:0 auto; padding:40px 16px 72px; }
.hero { text-align:center; margin-bottom:36px; }
.pildora { display:inline-flex; align-items:center; gap:8px; background:var(--verde-suave); border:1px solid #cdeec3; color:#2b4d22; font-size:13px; padding:6px 14px; border-radius:999px; }
.pildora::before { content:""; width:8px; height:8px; border-radius:50%; background:var(--verde); }
h1 { font-size:clamp(28px, 4.6vw, 44px); line-height:1.15; font-weight:700; margin:18px 0 10px; letter-spacing:-.01em; }
.resaltado { background:var(--degradado); -webkit-background-clip:text; background-clip:text; color:transparent; text-decoration:underline; text-decoration-color:var(--verde); text-underline-offset:6px; text-decoration-thickness:3px; }
.hero p { color:var(--suave); max-width:640px; margin:0 auto; }
.resumen-global { display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; margin:0 0 28px; }
.resumen-global div { background:var(--tarjeta); border:1px solid var(--borde); border-radius:var(--radio); padding:14px 16px; }
.resumen-global span { display:block; font-size:12px; color:var(--suave); }
.resumen-global strong { font-size:22px; font-weight:700; }
.tienda { background:var(--tarjeta); border:1px solid var(--borde); border-radius:var(--radio); padding:22px; margin-bottom:18px; box-shadow:0 1px 2px rgba(0,0,0,.03); }
.cabecera { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:flex-start; gap:10px; }
h2 { margin:0; font-size:20px; font-weight:600; }
.cabecera a { font-size:13px; color:var(--suave); text-decoration:none; }
.cabecera a:hover { color:var(--texto); text-decoration:underline; }
.chips { display:flex; gap:6px; flex-wrap:wrap; }
.chip { font-size:12px; font-weight:500; padding:4px 10px; border-radius:999px; background:#f1f5f9; color:#334155; }
.chip.estado { background:var(--verde-suave); color:var(--verde-texto); }
.chip.atrasada { background:var(--error-fondo); color:var(--error); }
.chip.gris { background:#f1f1f1; color:var(--suave); }
.metricas { display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; margin:18px 0 6px; }
.metrica { border:1px solid var(--borde); border-radius:8px; padding:10px 12px; min-width:0; }
.metrica span { display:block; font-size:12px; color:var(--suave); }
.metrica strong { display:block; font-size:15px; font-weight:600; }
.metrica small { font-size:12px; font-weight:400; color:var(--suave); }
.metrica.destacada { border-color:#cdeec3; background:var(--verde-suave); }
.metrica.destacada strong { color:var(--verde-texto); font-size:18px; }
.metrica strong.atrasada { color:var(--error); }
.aviso { background:var(--aviso-fondo); color:var(--aviso); font-size:13px; border-radius:8px; padding:8px 12px; margin:10px 0 0; }
.generando { display:flex; gap:10px; align-items:flex-start; color:var(--suave); font-size:14px; margin:16px 0 4px; }
.punto { flex:none; width:10px; height:10px; margin-top:6px; border-radius:50%; background:var(--celeste); animation:pulso 1.2s ease-in-out infinite; }
@keyframes pulso { 50% { opacity:.3; } }
.feeds { margin-top:14px; border-top:1px solid var(--borde); padding-top:6px; }
.feed { display:grid; grid-template-columns:220px 1fr auto; gap:10px; align-items:center; padding:7px 0; }
.plataforma { display:flex; align-items:center; gap:10px; font-weight:500; font-size:14px; }
.marca { font-style:normal; width:26px; height:26px; border-radius:7px; display:grid; place-items:center; color:#fff; font-size:13px; font-weight:700; }
.marca-meta { background:#0866ff; } .marca-tiktok { background:#111; } .marca-pinterest { background:#e60023; } .marca-google { background:#34a853; }
input { width:100%; min-width:0; font:13px ui-monospace, "Cascadia Code", Consolas, monospace; color:#334155; padding:8px 10px; border:1px solid var(--borde); border-radius:8px; background:#fafafa; }
.copiar { font:inherit; font-size:13px; font-weight:500; padding:8px 14px; border-radius:8px; border:1px solid var(--borde); background:#fff; cursor:pointer; transition:border-color .15s, color .15s; }
.copiar:hover { border-color:var(--verde); }
.copiar.ok { background:var(--verde-suave); border-color:var(--verde); color:var(--verde-texto); }
.pie-tarjeta { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-top:10px; font-size:13px; }
.tecnico { color:var(--suave); white-space:nowrap; }
details { flex:1; min-width:0; }
summary { cursor:pointer; font-weight:500; color:#0a7fa3; }
.tabla { overflow-x:auto; }
table { width:100%; border-collapse:collapse; margin-top:10px; }
th, td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--borde); white-space:nowrap; }
th { font-size:12px; color:var(--suave); font-weight:500; }
.vacio { text-align:center; color:var(--suave); padding:40px 0; }
.espacio { display:grid; grid-template-columns:280px minmax(0, 1fr); gap:18px; align-items:start; }
.lateral { background:var(--tarjeta); border:1px solid var(--borde); border-radius:var(--radio); padding:14px; position:sticky; top:78px; max-height:calc(100vh - 96px); display:flex; flex-direction:column; }
.lateral-cabecera { display:flex; justify-content:space-between; align-items:center; padding:2px 4px 10px; }
.lateral-cabecera span { font-size:12px; color:var(--suave); background:#f1f1f1; border-radius:999px; padding:2px 9px; }
.buscar { font:inherit; font-size:14px; margin-bottom:8px; background:#fafafa; }
.buscar:focus { outline:none; border-color:var(--verde); box-shadow:0 0 0 3px var(--verde-suave); }
.lista { overflow-y:auto; display:flex; flex-direction:column; gap:2px; margin:0 -4px; padding:0 4px; }
.item { display:flex; align-items:center; gap:10px; width:100%; text-align:left; font:inherit; background:none; border:1px solid transparent; border-radius:8px; padding:9px 10px; cursor:pointer; color:var(--texto); }
.item:hover { background:#f6f6f6; }
.item[hidden] { display:none; }
.item.activo { background:var(--verde-suave); border-color:#cdeec3; }
.item-texto { min-width:0; display:flex; flex-direction:column; }
.item-texto strong { font-size:14px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.item-texto small { font-size:12px; color:var(--suave); }
.luz { flex:none; width:9px; height:9px; border-radius:50%; background:var(--verde); box-shadow:0 0 0 3px var(--verde-suave); }
.luz.atrasada { background:var(--error); box-shadow:0 0 0 3px var(--error-fondo); }
.luz.gris { background:#c4c4c4; box-shadow:0 0 0 3px #f1f1f1; }
.sin-resultados { font-size:13px; color:var(--suave); margin:8px 4px; }
.detalle .tienda { margin-bottom:0; }
.detalle .tienda[hidden] { display:none; }
footer { text-align:center; color:var(--suave); font-size:13px; padding:0 16px 40px; }
footer a { color:var(--suave); }
@media (max-width:860px) { .espacio { grid-template-columns:1fr; } .lateral { position:static; max-height:none; } .lista { max-height:260px; } }
@media (max-width:760px) { .metricas, .resumen-global { grid-template-columns:1fr 1fr; } .feed { grid-template-columns:1fr auto; } .plataforma { grid-column:1 / -1; } .logo span { display:none; } }
</style>
</head>
<body>
<div class="barra"><div class="barra-in">
  <a class="logo" href="https://www.experimentality.co/es" target="_blank" rel="noopener"><img src="https://www.experimentality.co/logo-light.svg" alt="Experimentality"><span>Feeds VTEX</span></a>
  <a class="boton" href="https://github.com/${repo}/issues/new?template=nueva-tienda.yml" target="_blank" rel="noopener">+ Agregar tienda</a>
</div></div>
<main>
<section class="hero">
  <span class="pildora">Meta · TikTok · Pinterest · Google Merchant Center</span>
  <h1>Feeds de catálogo que se <span class="resaltado">actualizan</span> solos</h1>
  <p>Copia el enlace de cada plataforma y pégalo como feed programado. Menos de 2.500 productos: cada hora. Desde 2.500: una vez al día.</p>
</section>
<div class="resumen-global">
  <div><span>Tiendas</span><strong>${numero(tiendas.length)}</strong></div>
  <div><span>SKUs publicados</span><strong>${numero(totalPublicados)}</strong></div>
  <div><span>Última actualización</span><strong style="font-size:16px">${ultima ? fecha(ultima) : '—'}</strong></div>
</div>
${tiendas.length ? `<div class="espacio">
<aside class="lateral">
  <div class="lateral-cabecera"><strong>Tiendas</strong><span>${numero(tiendas.length)}</span></div>
  <input type="search" class="buscar" placeholder="Buscar tienda…" aria-label="Buscar tienda">
  <nav class="lista">${lista}</nav>
  <p class="sin-resultados" hidden>No hay tiendas con ese nombre.</p>
</aside>
<div class="detalle">${tarjetas}</div>
</div>` : '<p class="vacio">Aún no hay tiendas. Pulsa “Agregar tienda”.</p>'}
</main>
<footer>
  <a href="https://github.com/${repo}/actions" target="_blank" rel="noopener">Ver ejecuciones</a> ·
  <a href="https://github.com/${repo}/edit/main/tiendas.json" target="_blank" rel="noopener">Editar tiendas</a> ·
  Hecho por <a href="https://www.experimentality.co/es" target="_blank" rel="noopener">Experimentality</a>
</footer>
<script>
document.querySelectorAll('time').forEach(function (t) {
  var d = new Date(t.getAttribute('datetime'));
  if (!isNaN(d)) t.textContent = d.toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });
});
// Si la próxima actualización ya debió ocurrir hace más de 2 horas, se marca como atrasada.
var atrasada = function (iso) { return Date.now() - new Date(iso).getTime() > 2 * 3600e3; };
document.querySelectorAll('[data-proxima]').forEach(function (el) {
  if (atrasada(el.getAttribute('data-proxima'))) { el.classList.add('atrasada'); el.insertAdjacentText('beforeend', ' · atrasada'); }
});
document.querySelectorAll('[data-estado]').forEach(function (el) {
  if (!atrasada(el.getAttribute('data-estado'))) return;
  el.classList.add('atrasada');
  if (el.classList.contains('chip')) el.textContent = 'Atrasada';
});

// Lista lateral: muestra una tienda a la vez y recuerda la última elegida.
var tarjetas = document.querySelectorAll('.detalle .tienda');
var items = document.querySelectorAll('[data-abrir]');
function abrir(slug, desplazar) {
  var existe = document.getElementById('tienda-' + slug);
  if (!existe) slug = items.length ? items[0].getAttribute('data-abrir') : '';
  tarjetas.forEach(function (t) { t.hidden = t.getAttribute('data-slug') !== slug; });
  items.forEach(function (i) { i.classList.toggle('activo', i.getAttribute('data-abrir') === slug); });
  try { localStorage.setItem('feeds-tienda', slug); } catch (e) {}
  if (location.hash !== '#' + slug) history.replaceState(null, '', '#' + slug);
  if (desplazar && window.innerWidth <= 860) document.querySelector('.detalle').scrollIntoView({ behavior: 'smooth' });
}
items.forEach(function (i) { i.addEventListener('click', function () { abrir(i.getAttribute('data-abrir'), true); }); });
var guardada = ''; try { guardada = localStorage.getItem('feeds-tienda') || ''; } catch (e) {}
abrir(decodeURIComponent(location.hash.slice(1)) || guardada, false);
window.addEventListener('hashchange', function () { abrir(decodeURIComponent(location.hash.slice(1)), false); });

var buscar = document.querySelector('.buscar');
if (buscar) buscar.addEventListener('input', function () {
  var q = buscar.value.trim().toLowerCase(), visibles = 0;
  items.forEach(function (i) { var ok = i.getAttribute('data-buscar').indexOf(q) >= 0; i.hidden = !ok; if (ok) visibles++; });
  document.querySelector('.sin-resultados').hidden = visibles > 0;
});
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-copiar]');
  if (!b) return;
  var listo = function () { b.textContent = 'Copiado'; b.classList.add('ok'); setTimeout(function () { b.textContent = 'Copiar'; b.classList.remove('ok'); }, 1500); };
  if (navigator.clipboard) navigator.clipboard.writeText(b.dataset.copiar).then(listo, function () { b.previousElementSibling.select(); });
  else { b.previousElementSibling.select(); document.execCommand('copy'); listo(); }
});
</script>
</body>
</html>
`);
}

function productosPrevios(previo) {
  return (previo && previo.productos) || 0;
}

function frecuenciaHoras(t, previo) {
  if (Number(t.frecuencia_horas) > 0) return Number(t.frecuencia_horas);
  return productosPrevios(previo) >= UMBRAL_GRANDE ? 24 : 1;
}

function tocaActualizar(previo, horas) {
  if (horas <= 1 || !previo || !previo.actualizado) return true;
  const transcurrido = Date.now() - Date.parse(previo.actualizado);
  // Margen de 30 min para los retrasos del cron de GitHub.
  return !(transcurrido < horas * 3600e3 - 30 * 60e3);
}

async function generarTienda(t, previo) {
  const inicio = Date.now();
  const items = [];
  const fuentes = {};
  const productos = new Set();
  const skus = new Set();
  const conteo = { encontrados: 0, agotados: 0, incompletos: 0 };
  const rastreo = await rastrear(t, (lote) => {
    for (const p of lote) {
      productos.add(p.productId);
      agregarItems(p, t, items, skus, fuentes, conteo);
    }
  });
  if (!items.length) {
    throw new Error(`ningún SKU con stock para publicar (${conteo.encontrados} encontrados, ${conteo.agotados} agotados)`);
  }

  // Protección: una respuesta parcial de VTEX no debe vaciar el catálogo en las plataformas.
  // Se compara con los SKUs encontrados (no con los publicados) para no bloquear agotamientos reales.
  const encontradosAntes = previo && (previo.skus_encontrados || previo.skus);
  if (encontradosAntes && conteo.encontrados < encontradosAntes * 0.5) {
    throw new Error(`VTEX devolvió solo ${conteo.encontrados} SKUs frente a ${encontradosAntes} de la última vez`);
  }

  const dir = path.join(SALIDA, t.slug);
  fs.mkdirSync(dir, { recursive: true });
  const feeds = t.feeds || ['meta', 'google', 'tiktok', 'pinterest'];
  if (feeds.includes('meta')) escribir(path.join(dir, 'meta.csv'), feedMeta(items, t));
  if (feeds.includes('google')) escribir(path.join(dir, 'google.xml'), feedGoogle(items, t));
  if (feeds.includes('tiktok')) escribir(path.join(dir, 'tiktok.csv'), feedTikTok(items, t));
  if (feeds.includes('pinterest')) escribir(path.join(dir, 'pinterest.csv'), feedPinterest(items, t));

  const cambios = registrarCambios(dir, items);
  const segundos = Math.round((Date.now() - inicio) / 1000);
  const actualizado = new Date().toISOString();
  const historial = [{ fecha: actualizado, skus: items.length, skus_encontrados: conteo.encontrados,
    agotados: conteo.agotados, incompletos: conteo.incompletos, ...cambios }]
    .concat((previo && previo.historial) || []).slice(0, HISTORIAL);
  escribir(path.join(dir, 'estado.json'), JSON.stringify({
    tienda: t.nombre,
    actualizado,
    frecuencia_horas: frecuenciaHoras(t, { productos: productos.size }),
    duracion_segundos: segundos,
    productos_vtex: rastreo.total,
    productos: productos.size,
    grupos_de_precio: rastreo.grupos,
    skus_encontrados: conteo.encontrados,
    skus: items.length,
    agotados: conteo.agotados,
    incompletos: conteo.incompletos,
    cambios,
    fuente_precio: fuentes,
    feeds,
    historial,
  }, null, 2));

  console.log(`[${t.slug}] ${productos.size}/${rastreo.total} productos · SKUs: ${conteo.encontrados} encontrados, ` +
    `${items.length} publicados, ${conteo.agotados} agotados, ${conteo.incompletos} sin imagen o precio · ${segundos}s` +
    ` (${rastreo.grupos} grupos) · cambios: ${JSON.stringify(cambios)} · precio: ${JSON.stringify(fuentes)}`);
  if (impuestoMixto(fuentes)) {
    console.warn(`[${t.slug}] AVISO: ${fuentes.base} SKUs sin impuesto mientras el resto sí lo trae; revisa su precio en la tienda`);
  }
}

// Si ningún SKU trae impuesto, la tienda publica precios con IVA incluido (común en México)
// y el precio de VTEX ya es el del front. Solo es sospechoso cuando se mezclan ambos casos.
function impuestoMixto(fuentes) {
  if (!fuentes || !fuentes.base) return false;
  return Object.keys(fuentes).some((f) => f !== 'base' && fuentes[f] > 0);
}

// Compara cada SKU con la publicación anterior (precio, oferta, stock, título, link e imágenes)
// para mostrar en la app cuántos cambiaron realmente.
function registrarCambios(dir, items) {
  const archivo = path.join(dir, 'huellas.json');
  const anteriores = leerJson(archivo);
  const actuales = {};
  for (const i of items) {
    actuales[i.id] = [i.precio, i.oferta, i.disponible, i.titulo, i.link, i.imagenes.join(' ')].join('|');
  }
  escribir(archivo, JSON.stringify(actuales));
  if (!anteriores) return { primera_vez: true, nuevos: items.length, modificados: 0, eliminados: 0 };
  let nuevos = 0;
  let modificados = 0;
  for (const id of Object.keys(actuales)) {
    if (!(id in anteriores)) nuevos++;
    else if (anteriores[id] !== actuales[id]) modificados++;
  }
  const eliminados = Object.keys(anteriores).filter((id) => !(id in actuales)).length;
  return { nuevos, modificados, eliminados };
}

// ---------- VTEX ----------

async function pedir(url, intentos = 4) {
  for (let intento = 1; ; intento++) {
    try {
      const respuesta = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status} en ${url.split('?')[0]}`);
      return respuesta;
    } catch (error) {
      if (intento >= intentos) throw error;
      await new Promise((resolve) => setTimeout(resolve, 3000 * intento));
    }
  }
}

function urlBusqueda(t, fq, desde, hasta) {
  const query = new URLSearchParams({ _from: desde, _to: hasta, sc: t.sc || 1 });
  if (fq) query.set('fq', fq);
  if (t.region_id) query.set('regionId', t.region_id);
  // El firewall de VTEX rechaza "+" como espacio en fq; se envía %20.
  const qs = String(query).replace(/\+/g, '%20');
  return `https://${t.account}.vtexcommercestable.com.br/api/catalog_system/pub/products/search?${qs}`;
}

// VTEX informa el total en el encabezado "resources: 0-0/13000".
async function contar(t, fq) {
  const respuesta = await pedir(urlBusqueda(t, fq, 0, 0));
  await respuesta.arrayBuffer();
  const match = String(respuesta.headers.get('resources') || '').match(/\/(\d+)$/);
  if (!match) throw new Error('VTEX no informó el total de productos');
  return Number(match[1]);
}

// La API pública no pagina más allá de 2.500 productos. Los catálogos grandes
// se dividen por rangos de precio hasta que cada grupo quede por debajo del tope.
async function dividirPorPrecio(t, min, max) {
  const fq = `P:[${min} TO ${max}]`;
  const total = await contar(t, fq);
  if (total === 0) return [];
  if (total <= LIMITE_VTEX) return [{ fq, total }];
  if (max - min < 2) throw new Error(`más de ${LIMITE_VTEX} productos con precio cercano a ${min}; no se puede dividir`);
  const medio = Math.floor((min + max) / 2);
  return [...await dividirPorPrecio(t, min, medio), ...await dividirPorPrecio(t, medio, max)];
}

async function rastrear(t, alRecibirLote) {
  const total = await contar(t, '');
  const grupos = total <= LIMITE_VTEX ? [{ fq: '', total }] : await dividirPorPrecio(t, 0, PRECIO_MAXIMO);
  const paginas = [];
  for (const g of grupos) {
    for (let desde = 0; desde < g.total; desde += PAGINA) paginas.push({ fq: g.fq, desde });
  }
  await enParalelo(paginas, PARALELO, async ({ fq, desde }) => {
    const lote = await (await pedir(urlBusqueda(t, fq, desde, desde + PAGINA - 1))).json();
    if (!Array.isArray(lote)) throw new Error('respuesta inesperada de VTEX');
    alRecibirLote(lote);
  });
  return { total, grupos: grupos.length };
}

async function enParalelo(lista, limite, tarea) {
  let siguiente = 0;
  const trabajador = async () => {
    while (siguiente < lista.length) await tarea(lista[siguiente++]);
  };
  await Promise.all(Array.from({ length: Math.min(limite, lista.length) }, trabajador));
}

// ---------- Normalización ----------

// Solo se publica lo que el cliente puede comprar en el front: con stock, precio e imagen.
function agregarItems(p, t, items, vistos, fuentes, conteo) {
  for (const sku of p.items || []) {
    if (vistos.has(sku.itemId)) continue;
    vistos.add(sku.itemId);
    conteo.encontrados++;
    const seller = elegirSeller(sku.sellers || []);
    const oferta = (seller && seller.commertialOffer) || {};
    const venta = precioFront(oferta.Price, oferta, t);
    const lista = oferta.ListPrice > oferta.Price ? precioFront(oferta.ListPrice, oferta, t) : venta;
    const titulo = tituloSku(p, sku);
    const fotos = (sku.images || []).slice(0, Number(t.max_imagenes) || MAX_IMAGENES);
    const item = {
      id: String(sku.itemId),
      grupo: String(p.productId),
      titulo,
      descripcion: limpiarHtml(p.description || p.metaTagDescription) || t.descripcion_default || titulo,
      link: `${t.dominio.replace(/\/+$/, '')}/${p.linkText}/p?skuId=${sku.itemId}`,
      imagenes: fotos.map((i) => imagen(i.imageUrl, t.tamano_imagen || 800)).filter(Boolean),
      imagenesPinterest: fotos.map((i) => imagen(i.imageUrl, 1000, 1500)).filter(Boolean),
      disponible: venta.valor > 0 && (oferta.AvailableQuantity > 0 || oferta.IsAvailable === true),
      precio: lista.valor,
      oferta: lista.valor - venta.valor >= 1 ? venta.valor : 0,
      marca: t.marca || p.brand || t.nombre,
      gtin: /^\d{8}$|^\d{12,14}$/.test(sku.ean || '') ? sku.ean : '',
      categoria: categoria(p),
    };
    if (!item.disponible) { conteo.agotados++; continue; }
    if (!item.titulo || !item.imagenes.length || !(item.precio > 0)) { conteo.incompletos++; continue; }
    fuentes[venta.fuente] = (fuentes[venta.fuente] || 0) + 1;
    items.push(item);
  }
}

// Reproduce el precio que muestra el front: base + impuesto informado por VTEX.
function precioFront(base, oferta, t) {
  base = Number(base) || 0;
  const price = Number(oferta.Price) || 0;
  if (base <= 0) return { valor: 0, fuente: 'sin_precio' };
  const tax = Number(oferta.Tax) || 0;
  if (tax > 0 && price > 0) return { valor: base * (1 + tax / price), fuente: 'tax' };
  const cuota = (oferta.Installments || []).find(
    (x) => x.NumberOfInstallments === 1 && x.TotalValuePlusInterestRate > price + 0.01
  );
  if (cuota && price > 0) return { valor: base * (cuota.TotalValuePlusInterestRate / price), fuente: 'cuota' };
  const tasa = Number(oferta.taxPercentage) || 0;
  if (tasa > 0) return { valor: base * (1 + tasa), fuente: 'taxPercentage' };
  const ajuste = Number(t.ajuste_precio) || 1;
  return { valor: base * ajuste, fuente: ajuste !== 1 ? 'ajuste_manual' : 'base' };
}

function elegirSeller(sellers) {
  const conPrecio = sellers.filter((s) => s.commertialOffer && s.commertialOffer.Price > 0);
  return conPrecio.find((s) => s.sellerDefault) || conPrecio[0] || sellers[0] || null;
}

function tituloSku(p, sku) {
  const nombre = (p.productName || '').trim();
  const variante = (sku.name || '').trim();
  const titulo = variante && !nombre.toLowerCase().includes(variante.toLowerCase())
    ? `${nombre} - ${variante}` : nombre;
  return titulo.slice(0, 150);
}

function imagen(url, ancho, alto = ancho) {
  if (!url) return '';
  return String(url)
    .replace(/^http:/, 'https:')
    .replace(/(\/arquivos\/ids\/\d+)(-\d+-\d+)?/, `$1-${ancho}-${alto}`);
}

function categoria(p) {
  const ruta = (p.categories || []).slice().sort((a, b) => b.length - a.length)[0] || '';
  return ruta.split('/').filter(Boolean).slice(0, 5).join(' > ');
}

function limpiarHtml(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim().slice(0, 5000);
}

// ---------- Formatos ----------

function precio(valor, moneda) {
  if (!(valor > 0)) return '';
  const monto = SIN_DECIMALES.includes(moneda) ? String(Math.round(valor)) : valor.toFixed(2);
  return `${monto} ${moneda}`;
}

function csv(filas) {
  const celda = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return filas.map((f) => f.map(celda).join(',')).join('\n') + '\n';
}

function xml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

// Por defecto cada SKU es un producto independiente en Meta (sin item_group_id,
// que es lo que agrupa variantes bajo un producto padre). "agrupar_meta": true lo activa.
function feedMeta(items, t) {
  const agrupar = t.agrupar_meta === true;
  const cols = ['id', 'title', 'description', 'availability', 'condition', 'price', 'sale_price', 'link',
    'image_link', 'additional_image_link', 'brand', ...(agrupar ? ['item_group_id'] : []), 'product_type', 'gtin'];
  return csv([cols, ...items.map((i) => [
    i.id, i.titulo, i.descripcion, i.disponible ? 'in stock' : 'out of stock', 'new',
    precio(i.precio, t.moneda), precio(i.oferta, t.moneda), i.link,
    i.imagenes[0], i.imagenes.slice(1, 10).join(','), i.marca, ...(agrupar ? [i.grupo] : []), i.categoria, i.gtin,
  ])]);
}

function feedTikTok(items, t) {
  const cols = ['sku_id', 'title', 'description', 'availability', 'condition', 'price', 'sale_price', 'link',
    'image_link', 'additional_image_link', 'brand', 'item_group_id', 'product_type'];
  return csv([cols, ...items.map((i) => [
    i.id, i.titulo, i.descripcion, i.disponible ? 'in stock' : 'out of stock', 'new',
    precio(i.precio, t.moneda), precio(i.oferta, t.moneda), i.link,
    i.imagenes[0], i.imagenes.slice(1, 10).join(','), i.marca, i.grupo, i.categoria,
  ])]);
}

// Pinterest recomienda imágenes 2:3 y admite hasta 10 adicionales.
function feedPinterest(items, t) {
  const cols = ['id', 'title', 'description', 'link', 'image_link', 'additional_image_link', 'price',
    'sale_price', 'availability', 'condition', 'brand', 'item_group_id', 'product_type',
    'google_product_category'];
  return csv([cols, ...items.map((i) => [
    i.id, i.titulo, i.descripcion, i.link, i.imagenesPinterest[0], i.imagenesPinterest.slice(1, 11).join(','),
    precio(i.precio, t.moneda), precio(i.oferta, t.moneda), i.disponible ? 'in stock' : 'out of stock',
    'new', i.marca, i.grupo, i.categoria, t.google_product_category || '',
  ])]);
}

function feedGoogle(items, t) {
  const tag = (nombre, valor) => (valor ? `<g:${nombre}>${xml(valor)}</g:${nombre}>` : '');
  const cuerpo = items.map((i) => [
    '<item>',
    tag('id', i.id), tag('title', i.titulo), tag('description', i.descripcion), tag('link', i.link),
    tag('image_link', i.imagenes[0]),
    ...i.imagenes.slice(1, 11).map((img) => tag('additional_image_link', img)),
    tag('availability', i.disponible ? 'in_stock' : 'out_of_stock'), tag('condition', 'new'),
    tag('price', precio(i.precio, t.moneda)), tag('sale_price', precio(i.oferta, t.moneda)),
    tag('brand', i.marca), i.gtin ? tag('gtin', i.gtin) : tag('identifier_exists', 'no'),
    tag('item_group_id', i.grupo), tag('product_type', i.categoria),
    tag('google_product_category', t.google_product_category),
    '</item>',
  ].filter(Boolean).join('\n')).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n<channel>\n' +
    `<title>${xml(t.nombre)}</title>\n<link>${xml(t.dominio)}</link>\n<description>${xml(t.nombre)}</description>\n` +
    cuerpo + '\n</channel>\n</rss>\n';
}

// ---------- Archivos ----------

function escribir(archivo, contenido) {
  const temporal = archivo + '.tmp';
  fs.writeFileSync(temporal, contenido, 'utf8');
  fs.renameSync(temporal, archivo);
}

function leerJson(archivo) {
  try { return JSON.parse(fs.readFileSync(archivo, 'utf8').replace(/^﻿/, '')); } catch (_) { return null; }
}

main();
