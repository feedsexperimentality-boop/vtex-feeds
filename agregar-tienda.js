#!/usr/bin/env node
// Detecta una tienda VTEX a partir de su URL pública y la agrega a tiendas.json.
// Uso: node agregar-tienda.js https://www.mitienda.com.co [nombre]
// Imprime en la última línea un JSON con el resultado (lo usa el workflow).
'use strict';

const fs = require('fs');
const path = require('path');

const ARCHIVO = path.join(__dirname, 'tiendas.json');
const UMBRAL_GRANDE = 2500;
const MONEDA_POR_DOMINIO = [
  [/\.com\.co$|\.co$/, 'COP'], [/\.com\.mx$|\.mx$/, 'MXN'], [/\.com\.pe$|\.pe$/, 'PEN'],
  [/\.cl$/, 'CLP'], [/\.com\.ar$|\.ar$/, 'ARS'], [/\.com\.br$|\.br$/, 'BRL'],
  [/\.com\.ec$|\.ec$/, 'USD'], [/\.com\.do$|\.do$/, 'DOP'], [/\.com\.gt$|\.gt$/, 'GTQ'],
  [/\.cr$/, 'CRC'], [/\.com\.pa$|\.pa$/, 'USD'], [/\.com\.uy$|\.uy$/, 'UYU'], [/\.com\.py$|\.py$/, 'PYG'],
  [/\.com\.bo$|\.bo$/, 'BOB'], [/\.es$/, 'EUR'],
];

async function main() {
  const entrada = (process.argv[2] || '').trim();
  const nombreManual = (process.argv[3] || '').trim();
  const url = normalizarUrl(entrada);
  if (!url) return fallar('La URL no es válida. Ejemplo: https://www.mitienda.com.co');

  const html = await descargar(url.origin);
  if (!html) return fallar(`No se pudo abrir ${url.origin}`);

  const { cuenta: account, total } = await detectarCuenta(html);
  if (!account) return fallar(`No se encontró una tienda VTEX pública en ${url.origin}`);

  const tiendas = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8').replace(/^﻿/, ''));
  const dominio = url.origin;
  const existente = tiendas.find((t) => t.account === account || mismoDominio(t.dominio, dominio));
  if (existente) {
    return terminar({ ok: true, nueva: false, slug: existente.slug, nombre: existente.nombre, account,
      productos: total, espacio: Number(existente.espacio) || 0, base: baseEspacio(Number(existente.espacio) || 0) });
  }

  const segmento = await obtenerSegmento(account);
  const slug = crearSlug(url.hostname, tiendas);
  const tienda = {
    slug,
    nombre: nombreManual || nombreDesdeDominio(url.hostname),
    account,
    dominio,
    moneda: segmento.currencyCode || primero(html, /"currency":"([A-Z]{3})"/) || monedaPorDominio(url.hostname),
    sc: Number(segmento.channel) || Number(primero(html, /"salesChannel":"?(\d+)"?/)) || 1,
    marca: '',
    descripcion_default: '',
    ajuste_precio: 1,
    feeds: ['meta', 'google', 'tiktok', 'pinterest'],
  };
  // Las tiendas grandes van a un espacio propio de 1 GB: el que tenga más lugar libre.
  if (total >= UMBRAL_GRANDE) {
    const espacio = await elegirEspacio(tiendas);
    if (!espacio) return fallar('Todos los espacios para tiendas grandes están casi llenos. Hay que crear uno nuevo antes de agregar esta tienda.');
    tienda.espacio = espacio;
  }
  tiendas.push(tienda);
  fs.writeFileSync(ARCHIVO, JSON.stringify(tiendas, null, 2) + '\n', 'utf8');
  const espacio = tienda.espacio || 0;
  terminar({ ok: true, nueva: true, slug, nombre: tienda.nombre, account, moneda: tienda.moneda,
    productos: total, espacio, base: baseEspacio(espacio) });
}

// Elige el espacio con menos uso, sumando lo que ya se reservó para tiendas recién agregadas.
async function elegirEspacio(tiendas) {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'espacios.json'), 'utf8'));
  const opciones = await Promise.all((config.espacios || []).map(async (n) => {
    let bytes = 0;
    try {
      const r = await fetch(`${baseEspacio(n)}/uso.json?t=${Date.now()}`);
      if (r.ok) bytes = (await r.json()).bytes || 0;
    } catch (_) { /* espacio aún sin publicar */ }
    // Una tienda asignada que aún no publica se cuenta como 200 MB para no amontonarlas.
    const pendientes = tiendas.filter((t) => Number(t.espacio) === n).length;
    return { n, bytes: Math.max(bytes, pendientes * 200 * 1024 ** 2) };
  }));
  const libres = opciones.filter((o) => o.bytes < 0.7 * 1024 ** 3).sort((a, b) => a.bytes - b.bytes);
  return libres.length ? libres[0].n : 0;
}

function baseEspacio(n) {
  const dueno = (process.env.GITHUB_REPOSITORY_OWNER || 'feedsexperimentality-boop');
  return `https://${dueno}.github.io/vtex-feeds${n ? `-espacio-${n}` : ''}`;
}

function normalizarUrl(texto) {
  try {
    const limpio = texto.replace(/\s+/g, '');
    return new URL(/^https?:\/\//i.test(limpio) ? limpio : `https://${limpio}`);
  } catch (_) {
    return null;
  }
}

async function descargar(url) {
  try {
    const respuesta = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (VTEX Feeds)' }, redirect: 'follow' });
    return respuesta.ok ? await respuesta.text() : '';
  } catch (_) {
    return '';
  }
}

// La cuenta aparece en el runtime de VTEX IO y en los hosts de imágenes.
async function detectarCuenta(html) {
  const votos = {};
  const patrones = [
    /"account":"([a-z0-9-]+)"/g, /([a-z0-9-]+)\.vtexassets\.com/g,
    /([a-z0-9-]+)\.vteximg\.com\.br/g, /([a-z0-9-]+)\.vtexcommercestable\.com\.br/g,
  ];
  for (const patron of patrones) {
    for (const m of html.matchAll(patron)) votos[m[1]] = (votos[m[1]] || 0) + 1;
  }
  const candidatos = Object.keys(votos).sort((a, b) => votos[b] - votos[a]).slice(0, 5);
  for (const cuenta of candidatos) {
    try {
      const r = await fetch(`https://${cuenta}.vtexcommercestable.com.br/api/catalog_system/pub/products/search?_from=0&_to=0`,
        { headers: { Accept: 'application/json' } });
      const total = Number(String(r.headers.get('resources') || '').split('/')[1]);
      if (r.ok && total > 0) return { cuenta, total };
    } catch (_) { /* se prueba el siguiente candidato */ }
  }
  return { cuenta: '', total: 0 };
}

// Segmento público por defecto de la cuenta: moneda, país y canal de venta.
async function obtenerSegmento(cuenta) {
  try {
    const r = await fetch(`https://${cuenta}.vtexcommercestable.com.br/api/segments`, { headers: { Accept: 'application/json' } });
    return r.ok ? await r.json() : {};
  } catch (_) {
    return {};
  }
}

function primero(texto, patron) {
  const m = texto.match(patron);
  return m ? m[1] : '';
}

function monedaPorDominio(host) {
  const par = MONEDA_POR_DOMINIO.find(([patron]) => patron.test(host));
  return par ? par[1] : 'USD';
}

function mismoDominio(a, b) {
  const host = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  return host(a) === host(b);
}

function crearSlug(host, tiendas) {
  const base = host.replace(/^www\./, '').split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '') || 'tienda';
  let slug = base;
  for (let i = 2; tiendas.some((t) => t.slug === slug); i++) slug = `${base}-${i}`;
  return slug;
}

function nombreDesdeDominio(host) {
  const base = host.replace(/^www\./, '').split('.')[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function terminar(resultado) {
  console.log(JSON.stringify(resultado));
}

function fallar(mensaje) {
  console.log(JSON.stringify({ ok: false, error: mensaje }));
  process.exitCode = 1;
}

main();
