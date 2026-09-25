#!/usr/bin/env node
// Aplica una solicitud del formulario "Excluir productos" a tiendas.json.
// Lee el cuerpo del formulario desde la variable CUERPO e imprime un JSON con el resultado.
'use strict';

const fs = require('fs');
const path = require('path');

const ARCHIVO = path.join(__dirname, 'tiendas.json');
// Se reconocen por palabra clave para tolerar tildes o mayúsculas distintas.
const TIPOS = [[/^categor/i, 'categoria'], [/^colecci/i, 'coleccion'], [/^marca/i, 'marca'], [/^sku/i, 'sku'], [/^producto/i, 'producto']];
const FEEDS = [['Meta', 'meta'], ['TikTok', 'tiktok'], ['Pinterest', 'pinterest'], ['Google', 'google']];
const NOMBRES = { meta: 'Meta', tiktok: 'TikTok', pinterest: 'Pinterest', google: 'Google Merchant Center' };

const normalizar = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

function secciones(cuerpo) {
  const salida = {};
  let actual = null;
  for (const linea of String(cuerpo || '').split(/\r?\n/)) {
    const titulo = linea.match(/^###\s+(.+)$/);
    if (titulo) { actual = titulo[1].trim(); salida[actual] = []; continue; }
    if (actual) salida[actual].push(linea);
  }
  const campo = (inicio) => {
    const clave = Object.keys(salida).find((k) => normalizar(k).startsWith(normalizar(inicio)));
    return clave ? salida[clave].join('\n').trim() : '';
  };
  return campo;
}

// Archivos adjuntos (CSV o TXT) arrastrados al campo Valores: se usa la primera columna.
async function leerAdjuntos(texto) {
  const enlaces = [...texto.matchAll(/\((https:\/\/github\.com\/user-attachments\/files\/[^)\s]+)\)/g)].map((m) => m[1]);
  const valores = [];
  for (const url of enlaces) {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`No se pudo descargar el archivo adjunto (HTTP ${r.status}).`);
    const lineas = (await r.text()).replace(/^﻿/, '').split(/\r?\n/);
    lineas.forEach((linea, indice) => {
      const primera = linea.split(/[,;\t]/)[0].replace(/^"|"$/g, '').trim();
      // La primera fila se ignora si es un encabezado (ej. "sku", "id", "categoría").
      if (!primera || (indice === 0 && /^(sku|skus|id|ids|sku_id|producto|product|categor|coleccion|colecci|marca|brand)/i.test(primera))) return;
      valores.push(primera);
    });
  }
  return { enlaces, valores };
}

async function main() {
  const campo = secciones(process.env.CUERPO);
  const textoTienda = campo('Tienda');
  const accion = /volver/i.test(campo('Acci')) ? 'incluir' : 'excluir';
  const tipoTexto = campo('Qu');
  const tipo = (TIPOS.find(([patron]) => patron.test(tipoTexto)) || [])[1];
  let adjuntos;
  try { adjuntos = await leerAdjuntos(campo('Valores')); } catch (error) { return fallar(error.message); }
  const escritos = campo('Valores').split('\n')
    .filter((v) => !/user-attachments\/files\//.test(v))
    .map((v) => v.replace(/^[-*•]\s*/, '').split('\t')[0].trim())
    .filter((v) => v && v !== '_No response_');
  const valores = [...new Set(escritos.concat(adjuntos.valores))];
  const marcadas = campo('Plataformas').split('\n').filter((l) => /\[x\]/i.test(l));
  const feeds = FEEDS.filter(([etiqueta]) => marcadas.some((l) => l.includes(etiqueta))).map(([, id]) => id);

  if (!tipo) return fallar('No se reconoció qué quieres excluir.');
  if (!valores.length) return fallar('Escribe al menos un valor (uno por línea).');

  const tiendas = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8').replace(/^﻿/, ''));
  const buscado = normalizar(textoTienda).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  const tienda = tiendas.find((t) => [t.slug, t.nombre, t.account, t.dominio.replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, '')]
    .some((v) => normalizar(v) === buscado));
  if (!tienda) return fallar(`No encontré la tienda "${textoTienda}". Usa el nombre o el dominio que aparece en la app.`);

  const reglas = tienda.exclusiones || [];
  const todas = feeds.length === 0 || feeds.length === FEEDS.length;
  const clave = (t, v) => `${t}|${normalizar(v)}`;
  const indice = new Map(reglas.map((r) => [clave(r.tipo, r.valor), r]));

  for (const valor of valores) {
    const existente = indice.get(clave(tipo, valor));
    if (accion === 'excluir') {
      if (!existente) {
        const nueva = todas ? { tipo, valor } : { tipo, valor, feeds };
        reglas.push(nueva);
        indice.set(clave(tipo, valor), nueva);
      } else if (todas) delete existente.feeds;
      else if (existente.feeds) existente.feeds = [...new Set(existente.feeds.concat(feeds))];
    } else if (existente) {
      const restantes = todas ? [] : (existente.feeds || FEEDS.map(([, id]) => id)).filter((f) => !feeds.includes(f));
      if (restantes.length) existente.feeds = restantes;
      else { existente.borrar = true; indice.delete(clave(tipo, valor)); }
    }
  }
  const finales = reglas.filter((r) => !r.borrar);
  if (finales.length) tienda.exclusiones = finales; else delete tienda.exclusiones;
  fs.writeFileSync(ARCHIVO, JSON.stringify(tiendas, null, 2) + '\n', 'utf8');

  const donde = todas ? 'todos los feeds' : feeds.map((f) => NOMBRES[f]).join(', ');
  const muestra = valores.length > 10 ? `${valores.slice(0, 10).join(', ')} y ${valores.length - 10} más` : valores.join(', ');
  console.log(JSON.stringify({
    ok: true,
    slug: tienda.slug,
    nombre: tienda.nombre,
    espacio: Number(tienda.espacio) || 0,
    cantidad: valores.length,
    archivos: adjuntos.enlaces.length,
    resumen: `${accion === 'excluir' ? 'Excluido' : 'Vuelto a incluir'} en ${donde} (${valores.length}): ${muestra}`,
    reglas: agruparReglas(tienda.exclusiones || []),
  }));
}

// Resume las reglas: SKUs y productos se agrupan por cantidad para no listar miles de líneas.
function agruparReglas(reglas) {
  const grupos = new Map();
  const lineas = [];
  for (const r of reglas) {
    const destino = r.feeds ? r.feeds.map((f) => NOMBRES[f]).join(', ') : 'todos los feeds';
    if (r.tipo === 'sku' || r.tipo === 'producto') {
      const k = `${r.tipo}|${destino}`;
      grupos.set(k, (grupos.get(k) || 0) + 1);
    } else lineas.push(`${r.tipo}: ${r.valor} → ${destino}`);
  }
  for (const [k, n] of grupos) {
    const [tipo, destino] = k.split('|');
    lineas.push(`${n} ${tipo === 'sku' ? 'SKUs' : 'productos'} → ${destino}`);
  }
  return lineas;
}

function fallar(mensaje) {
  console.log(JSON.stringify({ ok: false, error: mensaje }));
  process.exitCode = 1;
}

main().catch((error) => fallar(error.message));
